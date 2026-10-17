# 开发与发布

本地开发、Windows EXE 打包、网页版与 Chrome 扩展，以及每次推送 `main` 后必须完成的 Archtree 同步。

<!-- @catalog -->
**Contents**

- [开发运行](#开发运行)
- [打包为单个 Windows EXE](#打包为单个-windows-exe)
- [Hosted browser version and Chrome extension](#hosted-browser-version-and-chrome-extension)
  - [Required Archtree synchronization after every main push](#required-archtree-synchronization-after-every-main-push)
  - [Local hosted development](#local-hosted-development)
<!-- @end-catalog -->

## 开发运行

要求 Node.js 24+ 和本机 Chrome。

```powershell
npm install
npm run build
npm start
```

开发时分别启动后端和 Vite：

```powershell
$env:NO_OPEN="true"
npm run dev
```

另一个终端：

```powershell
npm run dev:web
```

验证：

源码直连测试可在本地 `.env` 中配置 `OPENAI_ORG_ID` 和 `OPENAI_PROJECT_ID`，明确选择已开通模型权限的组织和项目。这些设置仅用于直连 OpenAI；打包版仍由 Archtree 服务端选择组织和项目。`npm run eval:ai` 使用匿名固定样本验证分类质量与用量。

开发时可用 `npx tsx src/tools/benchmarkAiThroughput.ts --run=<已完成的调查ID> --output=build/windows/smoke/performance.json` 测量重新处理原有样本的吞吐量。它使用已配置的本地密钥，固定 Luna 6 medium、每批 10 条、最多 12 个请求，不复用本地分类缓存，也不修改原调查；会产生新的 API 费用。直连计时不包含 Archtree 代理，因此不能代替 EXE 的全链路验证。

```powershell
npm test
npm run build
```

The hosted release runs these checks on Linux as well as local Windows development.
Portable configuration fixtures use native host paths and Chrome-launch tests use
the operating system's Chrome application mapping. Profile resolution explicitly
checks Windows, macOS, and Linux layouts independently of the test host.

## 打包为单个 Windows EXE

开发电脑运行以下命令即可生成免安装便携版：

```powershell
npm install
npm run package:win
```

成品固定为 `release/火影调查.exe`，每次成功打包会替换同一个文件；发布目录只提供这一个 EXE，构建中间文件放在 `build/windows/`。把这一个 EXE 交给其他 Windows 电脑即可；目标电脑不需要安装 Node.js、项目依赖或 OpenAI 密钥，但真实调查需要一个普通 Archtree 账号、Chrome 144 或更新版本，并由用户按页面提示授权连接已登录的 B站账号。

EXE 始终使用自身附带的网页与 Luna 6 服务配置。如果本机默认端口已被旧版或源码服务占用，EXE 会自动选择空闲端口，不会连接旧后台；同一个 EXE 再次打开时仍会回到已运行的窗口。

打包流程会先模拟“旧 5.6 服务占用默认端口”的场景，验证 EXE 的实际模型、独立后台、关键词前缀和本地演示报告，再替换发布文件。验证失败时保留原文件。

第一次运行时，Windows SmartScreen 可能会提示“未知发布者”，这是因为当前便携版尚未购买代码签名证书；用户确认来源可信后可选择继续运行。调查数据默认保存在当前 Windows 用户的“文档/火影手游玩家反馈调查工具/data”目录，也可以在主页中改到其他文件夹；如果 Windows 将“文档”重定向到 OneDrive，程序会跟随系统实际的“文档”位置。

## Hosted browser version and Chrome extension

The hosted build runs at `https://kashewt.com/naruto/`. It uses the same UI,
analysis protocol, reports, and investigation ZIP format as the desktop app.
The Windows EXE continues to use its existing local server, Chrome connection,
and Windows-encrypted session; building the hosted version does not replace it.

The browser version uses a Manifest V3 Chrome extension for Bilibili collection.
Download the extension ZIP from the site's extension guide, extract it to a
stable directory, open `chrome://extensions`, enable Developer mode, and select
**Load unpacked** with the directory containing `manifest.json`. Sign into
Bilibili in the same normal Chrome profile, refresh `/naruto/`, and connect the
extension. The guide describes these steps in the UI. The distribution is an
unpacked extension, not a Chrome Web Store publication.

Investigations, original records, analysis caches, checkpoints, and reports are
saved in this browser's IndexedDB on the user's device. Keep the investigation
page open during collection and analysis. After closure, the next page load
recovers unfinished work as paused; resuming reuses committed records and
analysis caches. Export investigation ZIPs to back up or transfer records between
the browser version and EXE. Clearing site data deletes local investigations.
Browser storage is independent of the EXE's chosen filesystem directory.

在网页版“历史调查”中，可点击某条记录的“删除调查”，确认后会永久删除
这份调查的原始记录、进度、分析缓存和报告。需要保留时请先导出 ZIP。
采集中请先暂停，分析中请等完成后再删除；其他调查和设置会保留。

Archtree login uses the existing same-origin HttpOnly browser session. The
extension never receives Archtree credentials or the OpenAI key. Browser
analysis requests use `/naruto/api/v1/classify`; only bounded, de-identified
classification fields go to Archtree. Archtree alone issues the provider API
requests with its existing server-only key and fixed protocol.

Build both hosted assets and the extension download:

```powershell
npm run build:hosted
```

Outputs are `web/hosted-dist/`, `build/chrome-extension/`, and
`build/naruto-mobile-chrome-extension.zip`. These generated artifacts remain
ignored. `npm run build` continues to produce the desktop bundle in `web/dist/`.

### Required Archtree synchronization after every `main` push

Every push to this repository's `main` branch must be followed by a matching
update on `yangyinxu/Archtree`'s `develop` branch, including documentation-only
pushes. The person or agent pushing Naruto is responsible for both steps;
pushing this repository alone does not update the hosted `/naruto/` site.

1. Commit and push the intended Naruto changes, then record the complete pushed
   commit SHA with `git rev-parse HEAD`.
2. In the Archtree checkout on `develop`, update the Naruto source handoff in
   its `docs/features/naruto.md` to that exact SHA. Prepare the hosted distribution from a clean
   checkout of that pushed commit with `npm run prepare:naruto-web -- <source-directory>`,
   and run `npm run smoke:naruto-web`. Verify that
   `naruto-web/dist/release-source.json` reports the same `sourceCommit` and
   `sourceDirty: false`.
3. Commit and push the matching Archtree synchronization to `develop`. Preserve
   unrelated changes and keep generated bundles, extension ZIPs, and deployment
   archives ignored.
4. Report both repository commits and distinguish the completed `develop`
   handoff from a production deployment. Before an authorized Archtree `main`
   release, set its Actions variable `NARUTO_SOURCE_COMMIT` to the same full
   Naruto SHA; changing the variable alone does not deploy anything. Routine
   synchronization must not push Archtree `main` or deploy production.

This is a required collaboration workflow, not an installed CI automation.

### Local hosted development

For development, start Archtree locally on port 8080 and run:

```powershell
npm run dev:web -- --mode hosted
```

Open `http://127.0.0.1:5173/naruto/`; the extension supports local HTTP portals
under `/naruto` on `localhost` or `127.0.0.1` at ports 5173, 3765, and 8080,
plus the production origin. After preparing the hosted bundle in Archtree, its
direct local entry is `http://localhost:8080/naruto`. Reload the extension and
portal after rebuilding or replacing extension files. It accepts only bounded
investigation commands and only navigates Bilibili URLs in its own collection tabs. Bilibili
access refusals, login requirements, and page changes are surfaced as recoverable
errors rather than bypassed.
Extension `0.1.5` briefly activates an owned collection tab when background
comments remain unreadable. These retries run one at a time inside the existing
investigation group and restore the prior tab only if the user has not changed
the selection. They require no additional extension permissions.
Extension `0.1.6` also accepts a rendered zero-comment count paired with the
loaded end-of-comments footer, preventing completed empty videos from remaining
pending indefinitely.
Extension `0.1.7` opens browser collection and login checks in separate new normal
Chrome windows without requesting focus. Parallel collection tabs share one
dedicated window and the orange investigation group. Comment retries change
selection only inside that window. The user's existing window keeps its active
tab. Cleanup closes only verified owned tabs; user-added or repurposed tabs keep
their window open.
Extension `0.1.8` automatically mutes every tool-created tab before opening
Bilibili, and reapplies mute when reusing it for another source. Foreground
comment retries stay muted, while existing user tabs retain their audio settings.
Replace the extension files, reload it in Chrome, and refresh the portal to use
this fix.
Extension `0.1.9` enforces the selected content window itself instead of trusting
Bilibili's search filter. It reads each source's real publish time (video
`pubdate`/`video:release_date`, 专栏 `publish_time`, opus `pub_ts`) and skips any
source outside the window or without a confirmable date. Search-card labels such
as `9月29日`, `3天前`, `昨天` and `2025-03-12` drop out-of-window results before
they are queued. The retired 动态 search (Bilibili no longer has that page) is
replaced by 专栏 article search sorted newest first, and each search gets an equal
share of the source limit so videos cannot crowd out articles. The portal
requires this version before starting or resuming live collection.
