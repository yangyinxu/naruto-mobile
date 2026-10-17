# 架构标准

本文规定代码、测试和文档放在哪里，以及各层之间允许的依赖方向。新增文件和移动文件都必须遵守；确实需要打破规则时，在同一次修改中更新本文并说明原因。各模块的运行流程和状态机见 [architecture.md](architecture.md)。

## 目录结构

```text
config/                         相关性和主题规则（JSON）
data/runs/<run-id>/             每次调查的独立本地目录（不提交）
docs/                           文档，见下文“文档布局”
extension/                      Chrome 扩展清单与说明；源码在 src/browserExtension/
scripts/                        扩展构建、Windows 打包与冒烟验证脚本
src/api/                        本机 Express API
src/browserExtension/           Manifest V3 扩展：后台、页面脚本、门户协议
src/collectors/                 B站浏览器与演示采集适配器
src/domain/                     数据类型、发布时间与输入校验（无 I/O）
src/infrastructure/             JSONL、检查点和运行锁
src/processing/                 清洗、Luna AI/演示规则分类和 Markdown 报告
src/services/                   调查运行状态机、归档、Chrome 连接、Archtree 登录与本机设置
src/tools/                      开发者评测与吞吐量工具（不进入发布包）
src/server.ts, src/electron.ts  本机服务器与 Electron 入口
web/src/components/             React 页面与组件
web/src/browser/                网页版运行时：IndexedDB 存储、扩展桥接、Archtree 认证
web/src/lib/                    桌面版 API 客户端与 HTML 报告
web/src/hooks/                  共享 React hooks
test/<area>/                    后端测试，按 src/ 下的目录分组
```

## 依赖方向

- `domain` 不依赖其他目录，也不做文件、网络或浏览器 I/O。
- `infrastructure` 只依赖 `domain`。
- `collectors` 依赖 `domain`、`config` 和 `services/chromeConnection`（浏览器采集需要 Chrome 连接）；`processing` 依赖 `domain`、`infrastructure` 和 `services/archtreeAuth`（AI 分类经 Archtree 代理）。新代码不要再增加 `collectors`/`processing` 对其他 `services` 的依赖。
- `services` 编排采集、处理和存储；`api` 只做请求校验并调用 `services`（以及 `processing/reporter` 生成报告），不直接读写调查文件。
- `browserExtension` 只依赖 `domain`，通过 `protocol.ts` 中的有界命令与门户通信。
- `web/src` 的产品代码只能复用 `src/` 中可以在浏览器运行的模块（`domain`、`processing` 中的纯逻辑）；Node 专用模块（`infrastructure`、`services`）只允许出现在 `*.desktop.test.ts` 这类桌面互通测试中。

## 测试

- 后端测试放在 `test/<area>/`，`<area>` 与被测代码所在的 `src/` 目录同名（`api`、`browserExtension`、`collectors`、`domain`、`infrastructure`、`processing`、`services`）；`src/` 根目录的模块（如 `config.ts`）的测试放在 `test/platform/`。
- 共享夹具放在 `test/fixtures/`，其中不放测试用例。
- 网页测试与被测文件同目录（`Foo.tsx` + `Foo.test.tsx`），由 Vitest 运行。

## 命名

- TypeScript 模块使用 `camelCase.ts`，以主要导出命名；React 组件使用 `PascalCase.tsx`。
- 脚本使用 `kebab-case.mjs`，文档使用 `kebab-case.md`。

## 文件目录（catalog）与文件大小

- 超过 100 行的手写源码、样式、脚本和 Markdown 文件，开头带有自动生成的目录：代码列出导出、内部声明和测试名称；CSS 列出类名、自定义属性和断点；Markdown 列出带链接的章节。JSON、生成文件和夹具不需要。
- 修改这类文件后运行 `npm run catalog:generate`；`npm test` 会先运行 `npm run catalog:check`，目录缺失或过期即失败。不要手工编辑目录。
- 目录只是导航，不代表文件可以无限变长。文件超过约 800 行或混合多种职责时，按其目录已经显示的边界拆分。

## 文档布局

| 路径 | 内容 |
| --- | --- |
| `README.md` | 工具简介、使用说明、数据与合规边界。 |
| `docs/README.md` | 全部文档索引。 |
| `docs/architecture-standards.md` | 本文。 |
| `docs/architecture.md` | 技术决策、运行流程、状态机与本地安全。 |
| `docs/data-contract.md` | 内容记录与意见记录的数据契约。 |
| `docs/research-plan.md` | 研究方案：采集对象、关键词、采样与分析标签。 |
| `docs/development.md` | 本地开发、Windows 打包、网页版与扩展、推送后的 Archtree 同步。 |
| `docs/design/` | 设计验收记录。 |
| `extension/README.md` | 扩展的安装、权限与测试说明。 |
