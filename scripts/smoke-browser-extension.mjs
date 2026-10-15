import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'build', 'chrome-extension');
await readFile(join(extension, 'manifest.json'));
const output = join(root, 'build', 'smoke', 'browser-extension');
await mkdir(output, {recursive: true});
const profile = await mkdtemp(join(output, 'profile-'));
const portalUrl = 'http://localhost:8080/naruto/';
const publishedAt = new Date(Date.now() - 86_400_000).toISOString();
let bilibiliRequests = 0;
let loginBlocked = true;
const delayedCommentMounts = [];
const navigationMuteSnapshots = [];
let context;
let testWorker;
try {
  const cdpMode = process.env.NARUTO_EXTENSION_TEST_MODE === 'cdp';
  const executablePath = process.env.NARUTO_EXTENSION_TEST_EXECUTABLE?.trim();
  if (cdpMode && !executablePath) throw new Error('CDP test mode requires an explicit NARUTO_EXTENSION_TEST_EXECUTABLE.');
  context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? {executablePath} : {channel: 'chromium'}), headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    // This optional flag is confined to a fresh test profile and a local pipe;
    // it does not change the production extension or any webpage origin rules.
    args: cdpMode ? ['--enable-unsafe-extension-debugging']
      : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  await context.exposeFunction('fixtureDelayedCommentMounted', (value) => delayedCommentMounts.push(value));
  // Headless Chrome reports every page as visible. Query the native selected tab
  // so this fixture still exercises the worker's foreground recovery path.
  await context.exposeBinding('fixtureCommentPageActive', async ({page}) => testWorker.evaluate(async (pageUrl) => {
    const active = await chrome.tabs.query({active: true});
    return active.some((tab) => tab.url === pageUrl);
  }, page.url()));
  // All Bilibili traffic is fulfilled from fixtures, with no live login or sampling.
  await context.route('https://*.bilibili.com/**', async (route) => {
    bilibiliRequests += 1;
    const url = new URL(route.request().url());
    if (route.request().isNavigationRequest() && url.pathname !== '/video/BVOriginal') {
      // The response is still held here: native muting must precede all page scripts,
      // including failed login documents and every navigation of a reused tool tab.
      const tabs = await testWorker.evaluate(async (requestedUrl) => {
        const saved = await chrome.storage.session.get('ownedTabs');
        const ownedIds = new Set((saved.ownedTabs || []).map((tab) => tab.id));
        return (await chrome.tabs.query({})).filter((tab) => ownedIds.has(tab.id)
          && (tab.pendingUrl === requestedUrl || tab.url === requestedUrl))
          .map((tab) => ({id: tab.id, muted: tab.mutedInfo?.muted}));
      }, url.href);
      navigationMuteSnapshots.push({url: url.href, tabs});
    }
    if (url.hostname === 'api.bilibili.com' && url.pathname === '/x/web-interface/nav') {
      if (loginBlocked) return route.abort('blockedbyclient');
      await route.fulfill({contentType: 'application/json',
        headers: {'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'"},
        body: JSON.stringify({code: 0, data: {isLogin: true, uname: 'Synthetic account', mid: 12345678}})});
      return;
    }
    if (url.hostname === 'search.bilibili.com') {
      const links = url.pathname === '/video'
        ? [0, 1, 2].map((index) => `<div><a href="https://www.bilibili.com/video/BVFixture${index}" title="Fixture video ${index}">Fixture video ${index}</a></div>`).join('')
        : '<div><a href="https://www.bilibili.com/opus/1234567890123">Fixture dynamic</a></div>';
      await route.fulfill({contentType: 'text/html; charset=utf-8', body: `<title>Synthetic Bilibili search</title>${links}`});
      return;
    }
    const title = url.pathname.includes('/opus/') ? 'Fixture dynamic' : 'Fixture video';
    // This source stays empty until real scrolling exposes its area and lazy components mount.
    const comments = /^\/video\/BVFixture1\/?$/.test(url.pathname) ? `
      <div style="height:2000px" aria-hidden="true">Synthetic page spacer</div>
      <div id="commentapp" style="min-height:320px"></div>
      <script>
        const area = document.querySelector('#commentapp');
        let loadedAt;
        const observer = new IntersectionObserver(() => mountVisibleComments());
        observer.observe(area);
        const activationPoll = setInterval(mountVisibleComments, 400);
        async function mountVisibleComments() {
          const rect = area.getBoundingClientRect();
          const elapsedMs = loadedAt === undefined ? 0 : performance.now() - loadedAt;
          // Model a background renderer that defers its first comment render until activation.
          if (elapsedMs < 4000 || rect.bottom <= 0 || rect.top >= innerHeight || area.dataset.mounted) return;
          if (!await window.fixtureCommentPageActive() || area.dataset.mounted) return;
          area.dataset.mounted = 'true';
          const comments = document.createElement('bili-comments');
          area.append(comments);
          const list = comments.attachShadow({mode: 'open'});
          for (const item of [
            {id: '1001', author: 'Fixture author', text: '技能后摇太长，无法反打', likes: 12},
            {id: '1002', parent: '1001', author: 'Fixture reply author', text: '我也遇到同样的问题', likes: 2}
          ]) {
            const host = document.createElement(item.parent ? 'bili-comment-reply-renderer' : 'bili-comment-renderer');
            host.__data = {rpid_str: item.id, parent_str: item.parent, root_str: item.parent,
              member: {mid: '1234', uname: item.author}, ctime: Math.floor(Date.now() / 1000) - 86400, like: item.likes};
            list.append(host);
            const root = host.attachShadow({mode: 'open'});
            const rich = document.createElement('bili-rich-text');
            root.append(rich);
            const text = document.createElement('span');
            text.id = 'contents'; text.textContent = item.text;
            rich.attachShadow({mode: 'open'}).append(text);
          }
          observer.disconnect();
          clearInterval(activationPoll);
          void window.fixtureDelayedCommentMounted({elapsedMs, visible: true, scrollY,
            decorated: location.pathname.endsWith('/') && new URL(location.href).searchParams.get('vd_source') === 'synthetic',
            foregroundAtMount: true});
        }
        addEventListener('scroll', mountVisibleComments, {passive: true});
        addEventListener('visibilitychange', mountVisibleComments);
        addEventListener('load', () => {
          loadedAt = performance.now();
          // The live site decorates the same BV URL after load, during the worker's settle wait.
          setTimeout(() => history.replaceState(null, '', location.pathname.replace(/\\/$/, '') + '/?vd_source=synthetic'), 250);
          setTimeout(mountVisibleComments, 4000);
        });
      </script>` : /^\/video\/BVFixture2\/?$/.test(url.pathname) ? `
      <div id="commentapp"><bili-comments></bili-comments></div>
      <script>
        const root = document.querySelector('bili-comments').attachShadow({mode: 'open'});
        root.innerHTML = '<div id="header"><bili-comments-header-renderer></bili-comments-header-renderer></div><div id="contents"></div><div id="end"><div class="bottombar">没有更多评论</div></div>';
        root.querySelector('bili-comments-header-renderer').attachShadow({mode: 'open'}).innerHTML = '<div id="title"><h2>评论</h2><div id="count">0</div></div>';
      </script>` : `
      <div id="commentapp">
        <div class="reply-item" data-rpid="1001"><a class="user-name" href="https://space.bilibili.com/1234">Fixture author</a><span class="reply-content">技能后摇太长，无法反打</span><span class="like">12</span><time>1天前</time></div>
        <div class="sub-reply-item" data-rpid="1002" data-parent-id="1001"><span class="user-name">Fixture reply author</span><span class="sub-reply-content">我也遇到同样的问题</span><span class="like">2</span></div>
      </div>`;
    await route.fulfill({contentType: 'text/html; charset=utf-8', body: `<!doctype html><title>${title}_哔哩哔哩</title>
      <meta property="og:description" content="Synthetic public context">
      <meta itemprop="datePublished" content="${publishedAt}">
      ${comments}`});
  });
  await context.route('http://localhost:8080/**', (route) => route.fulfill({contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Naruto extension synthetic portal</title><h1>Local extension smoke</h1>'}));
  // Fail unexpected requests rather than allowing a fixture to contact another service.
  await context.route(/^(?!https:\/\/[^/]+\.bilibili\.com\/|http:\/\/localhost:8080\/).+$/, (route) => route.abort());
  if (cdpMode) {
    const browser = context.browser();
    if (!browser) throw new Error('The isolated test browser does not expose a browser CDP session.');
    const session = await browser.newBrowserCDPSession();
    try {
      const loaded = await session.send('Extensions.loadUnpacked', {path: extension});
      assert.equal(typeof loaded.id, 'string');
      assert.ok(loaded.id.length > 0);
    } finally { await session.detach(); }
  }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 15_000});
  testWorker = worker;
  assert.match(worker.url(), /^chrome-extension:\/\//);
  await worker.evaluate(() => {
    globalThis.fixtureExtractionMuteSnapshots = [];
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = async (options) => {
      const tab = await chrome.tabs.get(options.target.tabId);
      fixtureExtractionMuteSnapshots.push({id: tab.id, url: tab.url, active: tab.active,
        muted: tab.mutedInfo?.muted, world: options.world});
      return executeScript(options);
    };
  });
  const assertToolTabsMuted = async (complete = false) => {
    assert.ok(navigationMuteSnapshots.length > 0);
    for (const snapshot of navigationMuteSnapshots) {
      assert.equal(snapshot.tabs.length, 1, `Missing owned tab before loading ${snapshot.url}`);
      assert.equal(snapshot.tabs[0].muted, true, `Tool tab must be muted before loading ${snapshot.url}`);
    }
    const extractions = await worker.evaluate(() => fixtureExtractionMuteSnapshots);
    for (const snapshot of extractions) {
      assert.equal(snapshot.muted, true, `Tool tab must remain muted when extracting ${snapshot.url}`);
    }
    if (complete) {
      for (const pattern of [/api\.bilibili\.com\/x\/web-interface\/nav/, /search\.bilibili\.com\/video/,
        /search\.bilibili\.com\/(?:all|dynamic)/, /\/video\/BVFixture[012]/, /\/opus\/1234567890123/]) {
        assert.ok(navigationMuteSnapshots.some((snapshot) => pattern.test(snapshot.url)), `Missing navigation mute coverage for ${pattern}`);
        assert.ok(extractions.some((snapshot) => pattern.test(snapshot.url)), `Missing extraction mute coverage for ${pattern}`);
      }
      const delayed = extractions.filter((snapshot) => /\/video\/BVFixture1\/?(?:\?|$)/.test(snapshot.url));
      assert.ok(delayed.some((snapshot) => snapshot.active === false && snapshot.world === 'MAIN'));
      assert.ok(delayed.some((snapshot) => snapshot.active === true && snapshot.world === 'MAIN'), 'Foreground comment retry must remain natively muted.');
    }
    return extractions;
  };
  const original = await context.newPage();
  await original.goto('https://www.bilibili.com/video/BVOriginal', {waitUntil: 'domcontentloaded'});
  const originalGroup = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({url: 'https://www.bilibili.com/video/BVOriginal'});
    await chrome.tabs.update(tabs[0].id, {muted: true});
    const groupId = await chrome.tabs.group({tabIds: tabs[0].id});
    await chrome.tabGroups.update(groupId, {title: 'Synthetic user group', color: 'blue', collapsed: true});
    return {tabId: tabs[0].id, windowId: tabs[0].windowId, groupId};
  });
  const portal = await context.newPage();
  await portal.goto(portalUrl);
  const mainWindow = await worker.evaluate(async (portalUrl) => {
    const [tab] = await chrome.tabs.query({url: portalUrl});
    await chrome.tabs.update(tab.id, {active: true, muted: false});
    // Set up the synthetic user's foreground window before observing the collector.
    await chrome.windows.update(tab.windowId, {focused: true});
    globalThis.fixtureWindowEvents = {created: [], focused: [], mainTabChanges: []};
    chrome.windows.onCreated.addListener((window) => fixtureWindowEvents.created.push({id: window.id, focused: window.focused}));
    chrome.windows.onFocusChanged.addListener((id) => {
      if (id !== chrome.windows.WINDOW_ID_NONE && id !== tab.windowId) fixtureWindowEvents.focused.push(id);
    });
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === tab.windowId && info.tabId !== tab.id) fixtureWindowEvents.mainTabChanges.push(info.tabId);
    });
    return {tabId: tab.id, windowId: tab.windowId};
  }, portalUrl);
  const assertMainWindowPreserved = async () => {
    const current = await worker.evaluate(async ({windowId, tabId, originalTabId}) => ({
      active: (await chrome.tabs.query({active: true, windowId})).map((tab) => tab.id),
      focused: (await chrome.windows.getLastFocused()).id,
      originalMuted: (await chrome.tabs.get(originalTabId)).mutedInfo?.muted,
      portalMuted: (await chrome.tabs.get(tabId)).mutedInfo?.muted,
      events: fixtureWindowEvents
    }), {...mainWindow, originalTabId: originalGroup.tabId});
    assert.deepEqual(current.active, [mainWindow.tabId]);
    assert.equal(current.focused, mainWindow.windowId);
    assert.equal(current.originalMuted, true);
    assert.equal(current.portalMuted, false);
    assert.deepEqual(current.events.mainTabChanges, []);
    assert.deepEqual(current.events.focused, []);
    assert.ok(current.events.created.every((window) => window.id !== mainWindow.windowId && window.focused === false));
  };
  await portal.evaluate(() => {
    window.fixtureEvents = [];
    window.addEventListener('message', (event) => {
      if (event.source === window && event.origin === location.origin && event.data?.channel === 'naruto-extension-v1'
        && event.data.direction === 'event') window.fixtureEvents.push(event.data);
    });
    window.fixtureRequest = (method, payload, timeout = 35_000) => new Promise((resolveRequest, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {window.removeEventListener('message', receive); reject(new Error('Fixture extension response timeout'));}, timeout);
      function receive(event) {
        if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'naruto-extension-v1'
          || event.data.direction !== 'response' || event.data.id !== id) return;
        clearTimeout(timer); window.removeEventListener('message', receive);
        event.data.error ? reject(new Error(event.data.error)) : resolveRequest(event.data.result);
      }
      window.addEventListener('message', receive);
      window.postMessage({channel: 'naruto-extension-v1', direction: 'request', id, method, payload}, location.origin);
    });
  });
  const call = (method, payload) => portal.evaluate(({method, payload}) => window.fixtureRequest(method, payload), {method, payload});
  const status = await call('status');
  assert.equal(status.connected, false);
  assert.equal(status.commentReadiness, 1);
  assert.equal(status.isolatedCollectionWindow, 1);
  await assert.rejects(call('connect'), /B站登录检查页面无法读取/);
  const blockedStatus = await call('status');
  assert.equal(blockedStatus.connected, false);
  assert.equal(blockedStatus.loginState, 'logged_out');
  assert.equal(context.pages().filter((page) => page.url().includes('bilibili.com')).length, 1);
  await assertMainWindowPreserved();
  await assertToolTabsMuted();
  loginBlocked = false;
  const connected = await call('connect');
  assert.equal(connected.connected, true);
  assert.equal(connected.commentReadiness, 1);
  assert.equal(connected.accountUidSuffix, '5678');
  assert.equal(Object.keys(connected).includes('mid'), false);
  await assertMainWindowPreserved();
  await assertToolTabsMuted();
  const runInput = (id) => ({manifest: {id, request: {name: 'Synthetic extension smoke', durationMinutes: 1, contentWindowDays: 30,
    keywords: ['火影手游'], includeVideos: true, includeDynamics: true, mode: 'live', browserVisible: true, browserWindowCount: 4, maxSources: 20}},
    checkpoint: {schemaVersion: 1, pendingCandidates: [], seenContentIds: [], seenOpinionIds: [], activeElapsedMs: 0, updatedAt: new Date().toISOString()}});
  const firstId = '20261013T200000-12345678';
  await call('start', runInput(firstId));
  let liveGroup;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    liveGroup = await worker.evaluate(async () => {
      const saved = await chrome.storage.session.get('ownedTabs');
      const tabs = await Promise.all((saved.ownedTabs || []).map((owned) => chrome.tabs.get(owned.id).catch(() => undefined)));
      const present = tabs.filter(Boolean);
      if (present.length !== 4 || present.some((tab) => tab.groupId < 0) || new Set(present.map((tab) => tab.groupId)).size !== 1) return undefined;
      return {tabs: present.map((tab) => ({id: tab.id, windowId: tab.windowId, groupId: tab.groupId, muted: tab.mutedInfo?.muted})),
        group: await chrome.tabGroups.get(present[0].groupId)};
    });
    if (liveGroup) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(liveGroup, 'All four tool tabs must share one real Chrome tab group while collecting.');
  assert.equal(liveGroup.group.title, '火影调查');
  assert.equal(liveGroup.group.color, 'orange');
  assert.equal(liveGroup.group.collapsed, false);
  assert.equal(new Set(liveGroup.tabs.map((tab) => tab.windowId)).size, 1);
  assert.equal(liveGroup.tabs.every((tab) => tab.windowId !== mainWindow.windowId && tab.id !== originalGroup.tabId), true);
  assert.equal(liveGroup.tabs.every((tab) => tab.muted === true), true);
  assert.notEqual(liveGroup.group.id, originalGroup.groupId);
  await assertMainWindowPreserved();
  await portal.waitForFunction((id) => window.fixtureEvents.some((event) => event.runId === id && event.type === 'complete'), firstId, {timeout: 35_000});
  const events = await portal.evaluate((id) => window.fixtureEvents.filter((event) => event.runId === id), firstId);
  await writeFile(join(output, 'events.json'), `${JSON.stringify(events, null, 2)}\n`);
  assert.equal(events.findLast((event) => event.type === 'complete').payload.outcome, 'source_exhausted');
  assert.equal(events.filter((event) => event.type === 'content').length, 4);
  assert.equal(events.filter((event) => event.type === 'opinion').length, 10);
  assert.equal(events.filter((event) => event.type === 'opinion' && event.payload.contentId === 'BVFixture2').length, 1);
  assert.equal(events.some((event) => event.type === 'content' && event.payload.type === 'dynamic'), true);
  assert.equal(events.some((event) => event.type === 'opinion' && event.payload.parentSourceRecordId === '1001'), true);
  const delayedOpinions = events.filter((event) => event.type === 'opinion' && event.payload.contentId === 'BVFixture1');
  assert.equal(delayedOpinions.length, 3);
  assert.equal(delayedOpinions.some((event) => event.payload.sourceRecordId === '1001'), true);
  assert.equal(delayedOpinions.some((event) => event.payload.sourceRecordId === '1002' && event.payload.parentSourceRecordId === '1001'), true);
  assert.ok(delayedCommentMounts.length >= 1);
  assert.ok(delayedCommentMounts.every((mount) => mount.elapsedMs >= 4000 && mount.visible === true && mount.scrollY > 0 && mount.decorated === true && mount.foregroundAtMount === true));
  const checkpoint = events.findLast((event) => event.type === 'checkpoint').payload;
  assert.equal(checkpoint.seenContentIds.length, 4);
  assert.equal(checkpoint.seenOpinionIds.length, 10);
  assert.equal(original.isClosed(), false);
  assert.equal(original.url(), 'https://www.bilibili.com/video/BVOriginal');
  assert.equal(context.pages().filter((page) => page.url().includes('bilibili.com')).length, 1);
  await assertMainWindowPreserved();
  assert.equal((await worker.evaluate(() => chrome.windows.getAll())).some((window) => window.id === liveGroup.tabs[0].windowId), false);
  await assertToolTabsMuted(true);

  const secondId = '20261013T200001-12345679';
  await call('start', runInput(secondId));
  await call('pause', {runId: secondId});
  await portal.waitForFunction((id) => window.fixtureEvents.some((event) => event.runId === id && event.type === 'complete'), secondId, {timeout: 30_000});
  const paused = await portal.evaluate((id) => window.fixtureEvents.findLast((event) => event.runId === id && event.type === 'complete').payload, secondId);
  assert.equal(paused.outcome, 'paused');
  await call('resume', {...runInput(secondId), checkpoint: paused.checkpoint});
  await portal.waitForFunction((id) => window.fixtureEvents.filter((event) => event.runId === id && event.type === 'complete').length === 2, secondId, {timeout: 35_000});
  const resumed = await portal.evaluate((id) => window.fixtureEvents.findLast((event) => event.runId === id && event.type === 'complete').payload, secondId);
  await writeFile(join(output, 'resumed-events.json'), `${JSON.stringify(await portal.evaluate((id) => window.fixtureEvents.filter((event) => event.runId === id), secondId), null, 2)}\n`);
  assert.equal(resumed.outcome, 'source_exhausted');
  assert.equal(resumed.checkpoint.seenOpinionIds.length, 10);
  assert.ok(delayedCommentMounts.length >= 2);
  assert.ok(delayedCommentMounts.every((mount) => mount.elapsedMs >= 4000 && mount.visible === true && mount.scrollY > 0 && mount.decorated === true && mount.foregroundAtMount === true));
  assert.equal(context.pages().filter((page) => page.url().includes('bilibili.com')).length, 1);
  const preservedGroup = await worker.evaluate(async ({tabId, groupId}) => ({tab: await chrome.tabs.get(tabId), group: await chrome.tabGroups.get(groupId)}), originalGroup);
  assert.equal(preservedGroup.tab.groupId, originalGroup.groupId);
  assert.equal(preservedGroup.group.title, 'Synthetic user group');
  assert.equal(preservedGroup.group.color, 'blue');
  assert.equal(preservedGroup.group.collapsed, true);
  await assertMainWindowPreserved();
  const extractionMuteSnapshots = await assertToolTabsMuted(true);
  await writeFile(join(output, 'mute-snapshots.json'), `${JSON.stringify({navigation: navigationMuteSnapshots, extraction: extractionMuteSnapshots}, null, 2)}\n`);
  assert.ok((await worker.evaluate(() => fixtureWindowEvents.created)).length >= 5);

  const beforeBlocked = bilibiliRequests;
  const wrongPage = await context.newPage();
  await wrongPage.goto('http://localhost:8080/narutox');
  const wrongResponse = await wrongPage.evaluate(() => new Promise((resolveWrong) => {
    const id = crypto.randomUUID();
    const receive = (event) => {if (event.data?.direction === 'response' && event.data?.id === id) resolveWrong(true);};
    window.addEventListener('message', receive);
    window.postMessage({channel: 'naruto-extension-v1', direction: 'request', id, method: 'start', payload: {}}, location.origin);
    setTimeout(() => {window.removeEventListener('message', receive); resolveWrong(false);}, 400);
  }));
  assert.equal(wrongResponse, false);
  assert.equal(bilibiliRequests, beforeBlocked);
  const foreignResponse = await portal.evaluate(() => new Promise((resolveForeign) => {
    const id = crypto.randomUUID();
    const receive = (event) => {if (event.data?.direction === 'response' && event.data?.id === id) resolveForeign(true);};
    window.addEventListener('message', receive);
    window.dispatchEvent(new MessageEvent('message', {source: window, origin: 'https://evil.test',
      data: {channel: 'naruto-extension-v1', direction: 'request', id, method: 'connect'}}));
    setTimeout(() => {window.removeEventListener('message', receive); resolveForeign(false);}, 400);
  }));
  assert.equal(foreignResponse, false);
  assert.equal(bilibiliRequests, beforeBlocked);
  await portal.screenshot({path: join(output, 'portal.png')});
  const result = {ok: true, browser: context.browser()?.version(), testMode: cdpMode ? 'cdp' : 'chromium', syntheticBilibiliRequests: bilibiliRequests,
    collectedSources: 4, collectedOpinions: 10, dedicatedCollectionWindow: true, mainWindowSelectionPreserved: true, mainWindowFocusPreserved: true,
    confirmedZeroComments: true, groupedToolTabs: true, userGroupPreserved: true, delayedCommentScroll: true, lateContentUrlDecoration: true, foregroundReadRetry: true,
    mutedBeforePageScripts: true, mutedDuringExtraction: true, foregroundRetryMuted: true, userMuteStatesPreserved: true,
    blockedLoginRecovery: true, pauseResume: true, originalTabPreserved: true, unapprovedPortalRejected: true};
  await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close();
  const absoluteProfile = resolve(profile);
  if (absoluteProfile.startsWith(`${resolve(output)}${sep}profile-`)) await rm(absoluteProfile, {recursive: true, force: true});
}
