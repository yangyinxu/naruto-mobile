# 本地网页版架构

## 已确认技术决策

- Node.js 24 + 严格 TypeScript
- Express 只监听 `127.0.0.1`
- React + Vite 提供中文网页 UI
- Playwright 使用本机 Chrome
- JSON/JSONL 本地文件存储，不使用 MongoDB 或 SQLite
- 后端使用 `node:test`，前端使用 Vitest

React 负责页面组件和交互状态；Vite 负责 TypeScript/JSX 编译和生产静态资源。正式运行时不启动 Vite，Express 只提供已经构建的 `web/dist/`。

## 运行流程

```text
浏览器 UI
  ↓ 本机 API / SSE
RunManager 状态机
  ├─ ChromeConnectionService
  │    └─ DevToolsActivePort → CDP → 日常 Chrome 默认上下文
  ├─ BilibiliBrowserCollector
  └─ DemoCollector
       ↓
只追加 raw JSONL + 原子 checkpoint.json
       ↓
清洗 → 规则分类 → 质量评估 → Markdown 报告
```

采集执行时长和内容发布时间范围是两个独立参数：

- `durationMinutes`：实际采集预算，默认 5 分钟；暂停不计时。
- `contentWindowDays`：候选内容发布时间范围，默认最近 30 天。
- `browserWindowCount`：真实调查的并行 Chrome 标签页数，范围 1–4，默认 1（保留原字段名以兼容已有任务）。

采集时间结束不包括后续清洗、分类和报告生成。

真实调查开始前，`ChromeConnectionService` 从 Chrome 用户数据目录读取 `DevToolsActivePort`，验证其为本机回环 WebSocket，并通过 Playwright `connectOverCDP` 连接。服务会新建一个临时页面调用 B站登录状态接口，确认当前默认浏览器上下文已经登录；端口和 WebSocket 路径不会发送到网页。

热门搜索发现阶段使用一个工具专用标签页；进入来源采集后，每个并行工作器在同一个已登录的默认 BrowserContext 中新建专用页面，因此共享 B站登录态。采集器只关闭自己创建的页面，不导航或关闭用户原有标签页。工作器并行读取页面，但写入原始 JSONL、运行统计和检查点时通过提交队列串行化，避免重复领取来源或并发覆盖检查点。暂停、提前结束或时间耗尽后不再领取新来源，已经开始的页面会完成当前步骤再保存。

## 状态机

```text
created → discovering → collecting
                         ↓
                  pause_requested
                         ↓
                       paused
                    ↙          ↘
              collecting     processing
                                  ↓
                     completed / completed_early
```

浏览器或应用意外关闭后，下一次启动会把活动任务恢复为 `paused`。用户可以继续采集或基于已经保存的数据直接生成报告。

## 本地安全

- 服务绑定固定回环地址，无法从局域网访问。
- Chrome CDP 端点必须解析为 `127.0.0.1`，不接受远程调试地址；连接状态 API 不返回端口、WebSocket 路径或 Cookie。
- Chrome 连接采用租约计数，真实调查运行期间禁止从网页主动断开。
- 修改型 API 检查请求来源。
- 运行 ID 必须符合固定格式，不能用于目录穿越。
- 每个活动任务使用本地锁，防止两个进程同时写入。
- 检查点采用临时文件写完后重命名，避免半写文件。
- 原始记录只追加，重新分类不会覆盖采集证据。
- 原始 JSONL 是 UTF-8 明文；schema v2 在每条记录内重复保存调查 ID，并把公开作者字段与评论放在同一记录中。
- 评论通过内容 ID、平台评论/父评论 ID、来源页、直达链接、发布时间和采集时间形成溯源链。
- 明文可溯源数据提高了本地目录的敏感度，因此运行数据默认被 Git 忽略，目录访问权限由使用者管理。

## 何时需要数据库

当前单机、单用户和数万条意见规模无需数据库。出现以下需求时再评估 DuckDB、SQLite 或 MongoDB：多用户并发、长期定时监控、跨数百次调查聚合、十万到百万级交互查询或远程权限系统。
