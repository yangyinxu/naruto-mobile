# 本地数据契约

每次调查保存在 `data/runs/<run-id>/`：

```text
manifest.json                   配置、当前状态、计时和统计
checkpoint.json                 待处理队列、已处理 ID 和恢复位置
events.jsonl                    可追加的活动与错误日志
raw/contents.jsonl              视频和动态元数据
raw/opinions.jsonl              标题、评论和回复
processed/opinions.jsonl        标准化和精确去重后的意见
processed/classifications.jsonl 多主题分析结果
processed/quality-report.json   去重、有效性和质量统计
reports/report.md               可独立阅读的最终报告
```

`manifest.json` 的请求配置包含 `browserWindowCount`（1–4）。旧清单没有该字段时按 1 个窗口恢复，以保持兼容。

## 明文与溯源原则

- `raw/*.jsonl` 是 UTF-8 明文、只追加的采集证据，不做字段加密或整文件加密。
- 用户名、公开 UID 和评论正文保存在同一条意见记录中，不维护容易错位的独立映射表。
- 每条新记录带 `recordSchemaVersion=2` 和 `runId`。目录名、记录内 `runId` 与 `manifest.json` 三者共同标识调查批次。
- 派生记录用 `opinionId` 引用原始意见；重新清洗或分类不覆盖 `raw/`。
- 历史 schema v1 记录不会被补写无法恢复的用户名或原始 UID。

## 内容记录

内容记录保存 `runId`、内容 ID、类型、发现页 URL、规范来源 URL、浏览器最终 URL、标题、简介、发布时间、采集时间、发现关键词、热度顺序和公开互动指标。

## 意见记录

| 字段 | 说明 |
|---|---|
| `recordSchemaVersion` / `runId` | 记录版本与调查批次 |
| `id` / `contentId` | 本地稳定意见 ID 与所属内容 ID |
| `sourceType` / `voiceType` | 评论、回复、弹幕或创作者观点；观众或创作者 |
| `text` / `normalizedText` | 原始正文；后者只出现在可重建的处理层 |
| `authorUid` / `authorName` | 页面公开显示的原始 UID 与用户名，明文保存 |
| `authorProfileUrl` | 公开用户主页 |
| `authorHash` | 兼容旧版本的附加去重键；不替代原始作者字段 |
| `sourceRecordId` | 平台评论或回复 ID |
| `parentSourceRecordId` | 回复所属根评论/父评论 ID |
| `publishedAt` / `publishedAtText` | 可解析的 ISO 时间与页面原始时间标签 |
| `collectedAt` | 本机采集时间 |
| `sourcePageUrl` / `sourceUrl` | 内容页面与评论直达链接；无法获得直达链接时两者相同 |
| `likes` / `replies` | 页面能可靠读取到的公开互动数，否则为 0 |

清单中的 `counts.validOpinions` 专指通过过滤的观众意见；创作者标题单独保留，但不计入玩家样本量。页面未公开、当时未加载或无法可靠识别的字段保持缺失，不猜测或伪造。

分类记录保存相关性、多选主题、主题级情绪、行为意图、玩家自述分层、严重度、可行动性、置信度、分类器版本和命中证据。

主题允许多选。玩家分层只能根据用户明确自述，不根据昵称或语气推断。

工具不会自动删除或加密原始意见。由于其中包含可识别的公开账号信息，数据目录应由使用者控制访问与保留周期。三处独立来源只是高风险结论进入人工复核的最低门槛，不是充分条件。
