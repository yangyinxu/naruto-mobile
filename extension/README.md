# Local browser collector

This Manifest V3 extension connects the `/naruto` portal to the user's existing
Bilibili browser session. It opens only its own public search/content tabs and
extracts bounded visible comments and open ShadowRoots. It does not request
cookies, browser debugging, native messaging, or a local server. Cookies and
Bilibili credentials are never exported to the portal or backend.

## Build and preview

Use Node.js 24 and the repository's installed dependencies:

```powershell
node scripts/build-extension.mjs
```

The unpacked extension is written to `build/chrome-extension`. The distributable
ZIP is written to `build/naruto-mobile-chrome-extension.zip` and copied to
`web/hosted-dist/naruto-mobile-chrome-extension.zip`. Build the hosted Vite bundle
**before** the extension; Vite clears its output directory.

For local preview, open `chrome://extensions`, enable Developer mode, select
**Load unpacked**, and select `build/chrome-extension`. Open the portal at
`http://127.0.0.1:5173/naruto/` (or `localhost`; ports 3765 and 8080 are also
accepted). Port 8080 supports the built portal served directly by local Archtree
at `http://localhost:8080/naruto`.
Reload both the extension and portal after rebuilding. Production communication
is limited to `https://kashewt.com/naruto` and its descendant paths. The ZIP must
be extracted before loading unpacked; a Chrome Web Store installation requires
a separately published store listing.

If the extension responds but the Bilibili login check cannot read its page,
inspect Chrome's result for `https://api.bilibili.com/x/web-interface/nav`.
A browser error such as `ERR_BLOCKED_BY_CLIENT` requires resolving the exact
address's blocking rule before reconnecting. Login DOM extraction runs in the
extension's isolated world; only public content component reads require the
page's main world. Missing or malformed extraction results never replace the
previous public connection summary or start collection. Extension version
`0.1.1` includes this validation and the local Archtree port 8080 support.

Version `0.1.2` scrolls to the comment area and reacquires lazily mounted comment
components for up to nine seconds. A blank/loading placeholder is retryable;
only a rendered explicit empty state counts as no comments. A verification
page stays pending for the user's own action. The portal records a bounded
warning reason from a fixed local allowlist
without page bodies or upstream errors. Update/reload the extension and refresh
the portal before resuming an older investigation. The status handshake reports
`commentReadiness: 1`; the portal requires this capability before live collection
or legacy checkpoint repair, so an older installed collector cannot claim the
new readiness behavior.

Version `0.1.3` uses Chrome's `tabGroups` permission to place newly created
collector tabs in a dedicated orange group named `火影调查`. It never adopts
an existing group by name or adds the portal or pre-existing user tabs to it.
Pause and completion still close only individually owned, unrepurposed tabs;
user-added or repurposed tabs survive, and an empty group disappears naturally.
Grouping is required before collection proceeds, so a grouping failure pauses
with the committed local checkpoint available for retry. Chrome may ask to
accept the added tab-group permission when updating the installed extension.
See the official [Tabs group API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-group)
and [Tab Groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups).

Version `0.1.4` retains ownership when Bilibili decorates the same canonical
video/dynamic URL with a trailing slash or tracking query after navigation.
Different content IDs, foreign navigation, and changed tab-group/window placement
still detach the tab from collection and cleanup. Login and search pages keep
their exact ownership checks. This fixes an early-read rejection that could
cause subsequent candidates on that collector to fail immediately. Connection
messages include the loaded extension version, and bounded local failure stages
distinguish navigation, ownership, script execution, and snapshot validation
without exposing raw page errors or payloads.

Version `0.1.5` scrolls the actual observed `bili-comments` host first. If a
bounded background read still reports `not_ready`, one owned collector tab at a
time is activated for a second bounded read in its existing window/group. The
previous active tab is restored only while the collector still owns the active
selection, so a user tab switch takes precedence. Queued retries stop on pause,
disconnect, or expired collection time. This requires no new permissions and
does not focus a different browser window. Failed reads retain pending sources.

Version `0.1.6` also recognizes Bilibili's rendered zero-comment header together
with its visible end-of-comments footer as an empty source. A footer alone,
missing or positive count, or hidden marker remains retryable; a loading
placeholder never becomes a completed source.

Version `0.1.7` isolates login checks and collection in newly created normal
Chrome windows with `focused: false`. The initial blank tab is registered and
reused, and each collection's parallel tabs share its fixed window and orange
group. Foreground comment retries select tabs only inside this window; the
collector never requests window focus or changes the user's existing selection.
It removes only verified owned tabs, allowing an empty window to close naturally
while preserving windows that contain user-added or repurposed tabs. Closing a
collection window does not redirect work into the user's window.
This uses the existing permissions and the official
[Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows#method-create)
and [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-update).
The `isolatedCollectionWindow: 1` handshake is required by the hosted portal
before starting or resuming live collection, so an older installed extension
cannot silently run the new workflow in the user's window.

## Protocol and recovery

Portal requests use `window.postMessage` with the portal's exact origin:

```javascript
window.postMessage({
  channel: 'naruto-extension-v1', direction: 'request',
  id: crypto.randomUUID(), method: 'status'
}, location.origin);
```

Allowed methods are `status`, `connect`, `disconnect`, `start`, `pause`, `resume`,
and `finalize`. `start` and `resume` accept `{manifest, checkpoint}`. `pause` and
`finalize` accept `{runId}`. Responses carry `direction: 'response'`, the same
request ID, and either `result` or an `error` string.

Events carry `direction: 'event'`, `runId`, `type`, and `payload`:

- `state`: `{state, message}` with `discovering` or `collecting`.
- `candidates`: the full merged array of currently pending candidate records.
  The portal merges these with its previous candidate metadata by ID.
- `content` / `opinion`: one traceable public record.
- `checkpoint`: the full current checkpoint.
- `warning`: `{message, details?}` with no page bodies or credentials.
- `complete`: `{outcome, checkpoint}` with `paused`, `finalized`,
  `budget_exhausted`, or `source_exhausted`.

The portal must commit record events in order before committing their following
checkpoint. It must deduplicate opinion IDs on retry and recover interrupted
jobs as paused. Keep the portal and Chrome open during collection. Closing the
portal cooperatively stops collection; reopening resumes from the portal's
committed local checkpoint. A restarted service worker reclaims only tool tabs
recorded in session storage and does not resume an in-memory job automatically.
Session storage contains tool tab ownership and the allowlisted public login
summary, not collected records or login credentials. A remembered summary never
replaces the fresh login check before starting or resuming collection.
Resume re-runs bounded discovery, preserving pending sources and excluding
already completed IDs, so pausing between video and dynamic searches cannot
silently drop the remaining search types. The combined completed/pending target
count is bounded by the original `maxSources` setting.
On the first explicit resume after the comment-readiness update, an older live
investigation requeues its saved sources that have only creator/title records.
Existing source and opinion evidence, pending work, deduplication IDs, and spent
time remain intact. A durable local event marks this one-time recovery, including
across investigation ZIP export/import; new confirmed-empty sources are not
requeued repeatedly.

Collection supports 4 or 8 parallel tool tabs. Navigation is limited to explicit
Bilibili hosts and canonical video/dynamic links. Every navigation and DOM read
has a timeout. Existing user tabs are never navigated or closed; manually
repurposed tool tabs are left open. Login is checked through a tool-created
`x/web-interface/nav` page, returning only login state, public account name and
the last four UID digits. Platform verification and access restrictions require
the user's own action; the extension does not bypass them.

Tests use synthetic DOM and mocked Chrome APIs, never a real account:

```powershell
npx tsx --test test/browserExtension.test.ts test/browserPageReadiness.test.ts
npm run build:server
node scripts/build-extension.mjs
node scripts/smoke-browser-extension.mjs
```

The browser smoke uses a fresh temporary Chromium profile, an actual loaded
extension, the local Archtree portal origin on port 8080, and intercepted
synthetic pages for every Bilibili request. It never uses the user's Chrome
profile or contacts a real account. The smoke first blocks the login navigation,
verifies a readable failure and an intact connection status, then retries
successfully before collecting.
The smoke also delays one open-ShadowRoot comment component for at least four
seconds and requires a real scroll into its viewport before mounting it.
It models a background renderer by waiting for native Chrome tab activation,
including in headless Chrome where document visibility alone is insufficient.
Install the bundled test browser with
`node node_modules/playwright/cli.js install chromium` first.
If the bundled full Chromium executable cannot start on the host, an explicit
test-only executable can be selected with `NARUTO_EXTENSION_TEST_EXECUTABLE`;
it must support extensions, unlike the headless-shell distribution.

On a host where the bundled full Chromium cannot start, an installed Chrome
executable can be tested with the official experimental
[Extensions.loadUnpacked CDP command](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/).
This optional mode explicitly enables extension testing over Playwright's local
debugging pipe and always creates a new temporary profile. It does not attach to
the user's running Chrome, use their profile, alter system configuration, or
relax webpage origin/CORS protections. The normal bundled Chromium mode remains
the default:

```powershell
$env:NARUTO_EXTENSION_TEST_MODE = 'cdp'
$env:NARUTO_EXTENSION_TEST_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node scripts/smoke-browser-extension.mjs
Remove-Item Env:NARUTO_EXTENSION_TEST_MODE
Remove-Item Env:NARUTO_EXTENSION_TEST_EXECUTABLE
```
