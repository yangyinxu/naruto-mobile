import type {CandidateContent, ContentRecord, OpinionRecord, RunCheckpoint} from '../domain/types';
import {CHANNEL, collectionInput, contentUrl, isBilibiliUrl, isExtensionRequest, isPortalUrl, searchUrls, stableBrowserId, type CollectionInput} from './protocol';
import {readContentPage, readLoginPage, readSearchPage, type ContentSnapshot} from './pageScripts';

interface Tab {id?: number; url?: string; pendingUrl?: string; status?: string; windowId?: number; groupId?: number; active?: boolean}
/** The original placement fences cleanup against a user moving a tool tab. */
interface OwnedTab {url: string; windowId?: number; groupId: number; previousUrl?: string}
/** One operation creates its own group and only reuses it through a verified owned anchor. */
interface ToolGroup {windowId?: number; groupId?: number}
interface Port {
  name: string;
  sender?: {id?: string; tab?: Tab; frameId?: number; url?: string; documentId?: string};
  postMessage(value: unknown): void;
  disconnect(): void;
  onMessage: {addListener(callback: (value: unknown) => void): void};
  onDisconnect: {addListener(callback: () => void): void};
}
declare const chrome: {
  runtime: {id: string; onConnect: {addListener(callback: (port: Port) => void): void}};
  windows: {create(options: {url: 'about:blank'; type: 'normal'; focused: false}): Promise<{id?: number; tabs?: Tab[]} | undefined>};
  tabs: {
    create(options: {url: string; active: boolean; windowId?: number}): Promise<Tab>;
    group(options: {tabIds: number; groupId?: number; createProperties?: {windowId: number}}): Promise<number>;
    update(id: number, options: {url?: string; active?: boolean; muted?: boolean}): Promise<Tab>;
    query(options: {active: true; windowId: number}): Promise<Tab[]>;
    onActivated: {addListener(callback: (info: {tabId: number; windowId: number}) => void): void;
      removeListener(callback: (info: {tabId: number; windowId: number}) => void): void};
    get(id: number): Promise<Tab>;
    remove(ids: number | number[]): Promise<void>;
  };
  tabGroups: {update(id: number, options: {title: string; color: 'orange'; collapsed: boolean}): Promise<unknown>};
  scripting: {executeScript<T>(options: {target: {tabId: number}; world: 'ISOLATED' | 'MAIN'; func: (...args: never[]) => unknown; args?: unknown[]}): Promise<Array<{result?: T; error?: {message?: string}}>>};
  storage: {session: {get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void>}};
};
type Account = ReturnType<typeof readLoginPage>;
interface Job extends CollectionInput {
  port: Port;
  directive: 'continue' | 'pause' | 'finalize';
  startedAt: number;
  baseElapsedMs: number;
  owned: Set<number>;
  group: ToolGroup;
  disconnected: boolean;
}
let active: Job | undefined;
let account: Account = {loginState: 'logged_out'};
let connected = false;
const owned = new Map<number, OwnedTab>();
const livePorts = new WeakSet<Port>();
let registryQueue = Promise.resolve();
let commandQueue = Promise.resolve();
// Foreground recovery is serialized even if a previous native reader outlives its timeout.
let foregroundQueue = Promise.resolve();
let foregroundExecution: Promise<unknown> | undefined;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type CollectionWarningReason = 'not_ready' | 'verification_required' | 'extraction_error' | 'ownership_changed'
  | 'navigation_failed' | 'navigation_timeout' | 'injection_failed' | 'injection_timeout'
  | 'script_error' | 'script_result_missing' | 'invalid_snapshot' | 'no_valid_comments' | 'foreground_activation_failed';
type CollectionReadStage = 'navigation' | 'injection' | 'snapshot' | 'comments' | 'collection' | 'foreground';
const collectionWarningMessages: Record<CollectionWarningReason, string> = {
  not_ready: 'B站评论尚未加载完成，已保留来源，请稍后继续采集。',
  verification_required: 'B站要求人工验证，已保留来源，请在自己的浏览器完成后继续采集。',
  extraction_error: 'B站页面暂时无法读取，请确认网络、登录状态或人工验证后继续。',
  ownership_changed: '调查标签页已被更改或移动，已保留页面和来源，请稍后继续采集。',
  navigation_failed: 'B站来源页面未能打开，已保留来源，请稍后继续采集。',
  navigation_timeout: 'B站来源页面加载超时，已保留来源，请稍后继续采集。',
  injection_failed: '无法在 B站来源页面启动采集，已保留来源，请检查页面访问状态后重试。',
  injection_timeout: 'B站来源页面读取超时，已保留来源，请稍后继续采集。',
  script_error: 'B站页面采集脚本未能完成，已保留来源，请稍后继续采集。',
  script_result_missing: 'B站页面未返回采集结果，已保留来源，请稍后继续采集。',
  invalid_snapshot: 'B站页面采集结果格式不正确，已保留来源，请稍后继续采集。',
  no_valid_comments: 'B站页面未返回有效评论，已保留来源，请稍后继续采集。',
  foreground_activation_failed: '调查标签页暂时无法切到前台，已保留来源，请稍后继续采集。'
};

/** Only locally classified read failures may select a detailed public warning. */
class ContentReadError extends Error {
  constructor(readonly reason: CollectionWarningReason, readonly stage: CollectionReadStage = 'comments') {
    super(collectionWarningMessages[reason]);
  }
}

/** Serialized ownership metadata contains no cookies, raw records, or account credentials. */
function persistOwned() {
  const value = [...owned].map(([id, placement]) => ({id, ...placement}));
  const next = registryQueue.catch(() => undefined).then(() => chrome.storage.session.set({ownedTabs: value}));
  registryQueue = next;
  return next;
}
/** A moved or regrouped tab belongs to the user even if its URL did not change. */
function samePlacement(tab: Tab, expected: OwnedTab) {
  return (expected.windowId === undefined || tab.windowId === expected.windowId)
    && (tab.groupId ?? -1) === expected.groupId;
}
/** Page-added tracking may change a public content URL without changing its source identity. */
function ownedUrlMatches(expected: string, observed: string | undefined) {
  return observed === expected || (typeof observed === 'string'
    && Boolean(contentUrl(expected, 'video') || contentUrl(expected, 'dynamic'))
    && navigationTargetMatches(expected, observed));
}
function ownsDocument(tab: Tab, expected: OwnedTab) {
  return samePlacement(tab, expected) && ownedUrlMatches(expected.url, tab.pendingUrl ?? tab.url);
}
async function closeOwned(id: number) {
  const expected = owned.get(id);
  if (expected === undefined) return;
  let tab: Tab | undefined;
  try {
    tab = await chrome.tabs.get(id);
  } catch (error) {
    const missing = error instanceof Error && (error.message === `No tab with id: ${id}.` || error.message === `No tab with id: ${id}`);
    if (!missing) throw new Error('调查标签页状态暂时无法确认，请稍后重试清理。');
  }
  // Failed removal retains the registry entry so later cleanup can retry it.
  if (tab && (ownsDocument(tab, expected) || (samePlacement(tab, expected)
    && expected.previousUrl !== undefined && ownedUrlMatches(expected.previousUrl, tab.pendingUrl ?? tab.url)))) await chrome.tabs.remove(id);
  owned.delete(id);
  await persistOwned();
}
const initialized = (async () => {
  const saved = await chrome.storage.session.get('ownedTabs');
  // Preserve an oversized registry untouched rather than silently losing its cleanup tail.
  if (Array.isArray(saved.ownedTabs) && saved.ownedTabs.length > 128) throw new Error('调查标签页清理记录超过限制。');
  if (Array.isArray(saved.ownedTabs)) for (const value of saved.ownedTabs) {
    if (value && typeof value === 'object' && Number.isSafeInteger(value.id)
      && typeof value.url === 'string' && (value.url === 'about:blank' || isBilibiliUrl(value.url))) {
      // Older workers created ungrouped tabs; never reclaim one the user grouped later.
      owned.set(value.id, {url: value.url,
        ...(Number.isSafeInteger(value.windowId) ? {windowId: value.windowId} : {}),
        ...(typeof value.previousUrl === 'string' && (value.previousUrl === 'about:blank' || isBilibiliUrl(value.previousUrl))
          ? {previousUrl: value.previousUrl} : {}),
        groupId: Number.isSafeInteger(value.groupId) && value.groupId >= -1 ? value.groupId : -1});
    }
  }
  // A suspended worker cannot safely resume an in-memory job. The portal's
  // committed checkpoint remains authoritative; reclaim only recorded tool tabs.
  await Promise.all([...owned.keys()].map(closeOwned));
  const savedConnection = (await chrome.storage.session.get('connection')).connection;
  if (savedConnection && typeof savedConnection === 'object') {
    const summary = savedConnection as Record<string, unknown>;
    if (summary.connected === true && summary.loginState === 'logged_in'
      && typeof summary.accountName === 'string' && summary.accountName.length <= 200
      && typeof summary.accountUidSuffix === 'string' && /^\d{1,4}$/.test(summary.accountUidSuffix)) {
      connected = true;
      account = {loginState: 'logged_in', accountName: summary.accountName, accountUidSuffix: summary.accountUidSuffix};
    }
  }
})().catch(() => { throw new Error('浏览器扩展的本地状态无法读取，请重新加载扩展。'); });

/** Decode untrusted script results before they can replace a valid public login summary. */
function decodeAccount(value: unknown): Account {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('B站登录状态格式不正确，请重新连接。');
  const summary = value as Record<string, unknown>;
  if (summary.loginState === 'logged_out') return {loginState: 'logged_out'};
  if (summary.loginState !== 'logged_in' || typeof summary.accountName !== 'string'
    || !summary.accountName.trim() || summary.accountName.length > 200 || /[\u0000-\u001f]/.test(summary.accountName)
    || typeof summary.accountUidSuffix !== 'string' || !/^\d{1,4}$/.test(summary.accountUidSuffix)) {
    throw new Error('B站登录状态格式不正确，请重新连接。');
  }
  return {loginState: 'logged_in', accountName: summary.accountName.trim(), accountUidSuffix: summary.accountUidSuffix};
}

async function connectionSummary(value: Account) {
  const next = decodeAccount(value);
  const nextConnected = next.loginState === 'logged_in';
  // Retain only the public handshake across worker suspension; every start
  // independently checks the actual login again before reading any comments.
  await chrome.storage.session.set({connection: {connected: nextConnected, ...next}});
  account = next;
  connected = nextConnected;
}

function status() {
  return {state: connected ? 'connected' : 'ready', remoteDebuggingEnabled: false, connected,
    ...account, extensionVersion: '0.1.8', commentReadiness: 1, isolatedCollectionWindow: 1, activeInvestigations: active ? 1 : 0,
    message: connected ? '浏览器扩展 0.1.8 已连接，将在当前电脑采集公开意见。' : '浏览器扩展 0.1.8 已就绪，请登录 B站后点击连接浏览器扩展。'};
}
function event(job: Job, type: string, payload: unknown) {
  if (job.disconnected) return;
  try { job.port.postMessage({channel: CHANNEL, direction: 'event', runId: job.manifest.id, type, payload}); }
  catch { job.disconnected = true; job.directive = 'pause'; }
}
function remaining(job: Job) {
  return Math.max(0, job.manifest.request.durationMinutes * 60_000 - job.baseElapsedMs - (Date.now() - job.startedAt));
}
function checkpoint(job: Job) {
  job.checkpoint.activeElapsedMs = job.baseElapsedMs + Math.max(0, Date.now() - job.startedAt);
  job.checkpoint.updatedAt = new Date().toISOString();
  event(job, 'checkpoint', structuredClone(job.checkpoint));
}
/** Reusing a group requires a tab we still own in its original document and window. */
async function hasGroupAnchor(group: ToolGroup) {
  if (group.groupId === undefined) return false;
  for (const [id, expected] of owned) {
    if (expected.groupId !== group.groupId || expected.windowId !== group.windowId) continue;
    try { if (ownsDocument(await chrome.tabs.get(id), expected)) return true; } catch { /* Check the next owned anchor. */ }
  }
  return false;
}
async function toolTab(group: ToolGroup, job?: Job) {
  if (owned.size >= 12) throw new Error('调查标签页清理尚未完成，请重新加载扩展后重试。');
  let tab: Tab;
  if (group.windowId === undefined) {
    // Reuse the new window's initial tab; never create an orphan blank or adopt a user's window.
    const window = await chrome.windows.create({url: 'about:blank', type: 'normal', focused: false});
    if (!window || !Number.isSafeInteger(window.id) || !Number.isSafeInteger(window.tabs?.[0]?.id)) throw new Error('无法创建独立调查窗口，请稍后重试。');
    group.windowId = window.id;
    tab = window.tabs![0];
  } else {
    if (!await hasGroupAnchor(group)) throw new Error('独立调查窗口已被更改或关闭，请稍后继续采集。');
    tab = await chrome.tabs.create({url: 'about:blank', active: false, windowId: group.windowId});
  }
  if (tab.id === undefined) throw new Error('无法创建调查标签页。');
  const id = tab.id;
  const expected: OwnedTab = {url: 'about:blank', windowId: tab.windowId, groupId: tab.groupId ?? -1};
  owned.set(id, expected);
  job?.owned.add(tab.id);
  try {
    await persistOwned();
    if (tab.windowId === undefined || (group.windowId !== undefined && tab.windowId !== group.windowId)
      || !ownsDocument(await chrome.tabs.get(id), expected)) throw new Error('调查标签页已被用户移动。');
    // Mute the owned blank tab before any site code can play audio, including
    // the initial tab returned by windows.create. This also covers Web Audio.
    await chrome.tabs.update(id, {muted: true});
    const reuse = await hasGroupAnchor(group);
    if (!ownsDocument(await chrome.tabs.get(id), expected)) throw new Error('调查标签页已被用户更改。');
    const groupId = await chrome.tabs.group({tabIds: id, ...(reuse ? {groupId: group.groupId}
      : {createProperties: {windowId: tab.windowId}})});
    if (!Number.isSafeInteger(groupId) || groupId < 0 || (reuse && groupId !== group.groupId)) throw new Error('调查标签组不可用。');
    const grouped = {...expected, groupId};
    owned.set(id, grouped);
    await persistOwned();
    if (!ownsDocument(await chrome.tabs.get(id), grouped)) throw new Error('调查标签页已被用户移动。');
    if (!reuse) await chrome.tabGroups.update(groupId, {title: '火影调查', color: 'orange', collapsed: false});
    group.windowId = tab.windowId;
    group.groupId = groupId;
    return id;
  } catch {
    await closeOwned(id).catch(() => undefined);
    throw new Error('无法创建火影调查标签组，请检查扩展权限后重试。');
  }
}

/** Binds a navigation to the requested public document, allowing only explicit
 * same-content aliases and query-equivalent search URLs. */
function navigationTargetMatches(requested: string, observed: string) {
  if (!isBilibiliUrl(requested) || !isBilibiliUrl(observed)) return false;
  const video = contentUrl(requested, 'video');
  if (video) return contentUrl(observed, 'video') === video;
  const dynamic = contentUrl(requested, 'dynamic');
  if (dynamic) {
    const redirected = contentUrl(observed, 'dynamic');
    return Boolean(redirected && dynamic.match(/\/(\d+)$/)?.[1] === redirected.match(/\/(\d+)$/)?.[1]);
  }
  const target = new URL(requested), final = new URL(observed);
  target.searchParams.sort();
  final.searchParams.sort();
  return target.origin === final.origin && target.pathname === final.pathname
    && target.searchParams.toString() === final.searchParams.toString();
}
async function navigateOwned(id: number, url: string) {
  if (!isBilibiliUrl(url) || !owned.has(id)) throw new ContentReadError('ownership_changed', 'navigation');
  const previous = await chrome.tabs.get(id);
  const expected = owned.get(id)!;
  if (!ownsDocument(previous, expected)) throw new ContentReadError('ownership_changed', 'navigation');
  owned.set(id, {...expected, url});
  try {
    await persistOwned();
    if (!ownsDocument(await chrome.tabs.get(id), expected)) throw new ContentReadError('ownership_changed', 'navigation');
  } catch (error) {
    // Navigation was never issued, so cleanup must still recognize the old document.
    owned.set(id, expected);
    throw error;
  }
  try { await chrome.tabs.update(id, {url, muted: true}); }
  catch (error) {
    let observed: Tab | undefined;
    try { observed = await chrome.tabs.get(id); } catch { /* An uncertain result retains both owned documents for cleanup. */ }
    if (observed && ownsDocument(observed, expected)) owned.set(id, expected);
    else if (!observed) owned.set(id, {...expected, url, previousUrl: expected.url});
    await persistOwned().catch(() => undefined);
    throw error;
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(id);
    if (!samePlacement(tab, expected)) throw new ContentReadError('ownership_changed', 'navigation');
    const current = tab.pendingUrl || tab.url || '';
    if (current && current !== 'about:blank' && !isBilibiliUrl(current)) throw new ContentReadError('ownership_changed', 'navigation');
    if (tab.pendingUrl && !navigationTargetMatches(url, tab.pendingUrl)) throw new ContentReadError('ownership_changed', 'navigation');
    // tabs.update can resolve while the old document is still complete and the
    // requested navigation is merely pending. Never extract that stale DOM.
    if (!tab.pendingUrl && tab.status === 'complete' && tab.url && tab.url !== 'about:blank') {
      if (!navigationTargetMatches(url, tab.url)) {
        // An old committed document may still be reported just after update.
        // Keep waiting for our target, but never adopt another Bilibili page.
        if (tab.url === previous.url) { await wait(100); continue; }
        throw new ContentReadError('ownership_changed', 'navigation');
      }
      owned.set(id, {...expected, url: tab.url});
      await persistOwned();
      await wait(800);
      return;
    }
    await wait(100);
  }
  throw new ContentReadError('navigation_timeout', 'navigation');
}
/** Platform failures select fixed diagnostics without forwarding browser error text. */
async function navigate(id: number, url: string) {
  try { await navigateOwned(id, url); }
  catch (error) {
    if (error instanceof ContentReadError) throw error;
    throw new ContentReadError('navigation_failed', 'navigation');
  }
}
/** DOM-only readers use the extension world; public component backing fields require MAIN. */
async function execute<T>(id: number, func: (...args: never[]) => unknown, args: unknown[] = [], world: 'ISOLATED' | 'MAIN' = 'ISOLATED',
  trackNative?: (execution: Promise<unknown>) => void): Promise<T> {
  let tab: Tab;
  try { tab = await chrome.tabs.get(id); } catch { throw new ContentReadError('injection_failed', 'injection'); }
  const expected = owned.get(id);
  if (!expected || !tab.url || !isBilibiliUrl(tab.url) || !ownsDocument(tab, expected)) throw new ContentReadError('ownership_changed', 'injection');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const native = chrome.scripting.executeScript<T>({target: {tabId: id}, world, func, args});
    trackNative?.(native);
    const results = await Promise.race([
      native,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ContentReadError('injection_timeout', 'injection')), 12_000); })
    ]);
    if (!Array.isArray(results) || results.length !== 1 || !results[0]) throw new ContentReadError('script_result_missing', 'injection');
    if (results[0].error) throw new ContentReadError('script_error', 'injection');
    if (results[0].result === undefined || results[0].result === null) throw new ContentReadError('script_result_missing', 'injection');
    return results[0].result;
  } catch (error) {
    if (error instanceof ContentReadError) throw error;
    throw new ContentReadError('injection_failed', 'injection');
  } finally { clearTimeout(timer); }
}
async function checkLogin(): Promise<Account> {
  const id = await toolTab({});
  try {
    let result: unknown;
    try {
      await navigate(id, 'https://api.bilibili.com/x/web-interface/nav');
      result = await execute<unknown>(id, readLoginPage);
    }
    catch { throw new Error('B站登录检查页面无法读取。请确认 api.bilibili.com 未被 Chrome 或其他扩展拦截，再重新连接。'); }
    return decodeAccount(result);
  } finally { await closeOwned(id); }
}
function dateFromText(value: string) {
  const full = value.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (full) return new Date(Date.UTC(Number(full[1]), Number(full[2]) - 1, Number(full[3]))).toISOString();
  const short = value.match(/(?:^|\s)(\d{1,2})[-/.](\d{1,2})(?:\s|$)/);
  if (!short) return undefined;
  const now = new Date();
  let date = new Date(Date.UTC(now.getUTCFullYear(), Number(short[1]) - 1, Number(short[2])));
  if (date.getTime() > now.getTime() + 86_400_000) date = new Date(Date.UTC(now.getUTCFullYear() - 1, Number(short[1]) - 1, Number(short[2])));
  return date.toISOString();
}
function commentTime(value: string | undefined, collectedAt: string) {
  if (!value) return undefined;
  const relative = value.match(/(\d+)\s*(秒|分钟|小时|天)前/);
  if (relative) return new Date(Date.parse(collectedAt) - Number(relative[1]) * ({秒: 1000, 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000}[relative[2]] || 0)).toISOString();
  if (/刚刚/.test(value)) return collectedAt;
  const full = value.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  // Bilibili's displayed clock is China Standard Time, independent of visitor timezone.
  if (full) return new Date(Date.UTC(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4] || 0) - 8, Number(full[5] || 0))).toISOString();
  const short = value.match(/(?:^|\s)(\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!short) return undefined;
  const year = new Date(Date.parse(collectedAt) + 8 * 3_600_000).getUTCFullYear();
  let date = new Date(Date.UTC(year, Number(short[1]) - 1, Number(short[2]), Number(short[3] || 0) - 8, Number(short[4] || 0)));
  if (date.getTime() > Date.parse(collectedAt) + 86_400_000) date = new Date(Date.UTC(year - 1, Number(short[1]) - 1, Number(short[2]), Number(short[3] || 0) - 8, Number(short[4] || 0)));
  return date.toISOString();
}
async function discover(job: Job, tabId: number) {
  event(job, 'state', {state: 'discovering', message: '正在发现热门视频和动态…'});
  const seen = new Set(job.checkpoint.seenContentIds);
  const candidates = [...new Map(job.checkpoint.pendingCandidates
    .filter((candidate) => !seen.has(candidate.id)).map((candidate) => [candidate.id, candidate])).values()]
    .slice(0, Math.max(0, job.manifest.request.maxSources - seen.size));
  for (const candidate of candidates) seen.add(candidate.id);
  // Re-running discovery is idempotent and completes searches interrupted by a
  // pause. Commit the merged pending set before any content worker can claim it.
  job.checkpoint.pendingCandidates = [...candidates];
  event(job, 'candidates', structuredClone(candidates));
  checkpoint(job);
  const cutoff = Date.now() - job.manifest.request.contentWindowDays * 86_400_000;
  let successfulSearches = 0;
  let attemptedSearches = 0;
  for (const target of searchUrls(job.manifest.request)) {
    if (job.directive !== 'continue' || remaining(job) < 20_000) break;
    if (job.checkpoint.seenContentIds.length + candidates.length >= job.manifest.request.maxSources) break;
    try {
      attemptedSearches += 1;
      await navigate(tabId, target.url);
      const links = await execute<Array<{href: string; title: string; context: string}>>(tabId, readSearchPage as (...args: never[]) => unknown, [target.type]);
      if (!Array.isArray(links) || links.length > 400) throw new Error('搜索结果格式不正确。');
      successfulSearches += 1;
      for (const link of links) {
        if (!link || typeof link.href !== 'string' || typeof link.title !== 'string' || typeof link.context !== 'string') continue;
        const url = contentUrl(link.href, target.type);
        const id = url?.match(target.type === 'video' ? /\/video\/(BV[\w]+)/ : /\/(\d{6,})$/)?.[1];
        if (!url || !id || seen.has(id)) continue;
        const publishedAt = dateFromText(link.context);
        if (publishedAt && Date.parse(publishedAt) < cutoff) continue;
        seen.add(id);
        candidates.push({id, type: target.type, url, discoveryUrl: target.url, title: link.title.slice(0, 2000) || id,
          discoveryKeyword: target.keyword, discoveryRank: job.checkpoint.seenContentIds.length + candidates.length + 1, popularityText: link.context.slice(0, 500), publishedAt});
        if (job.checkpoint.seenContentIds.length + candidates.length >= job.manifest.request.maxSources) break;
      }
      // Commit discovery incrementally so a pause never discards already found sources.
      job.checkpoint.pendingCandidates = [...candidates];
      event(job, 'candidates', structuredClone(candidates));
      checkpoint(job);
      if (job.checkpoint.seenContentIds.length + candidates.length >= job.manifest.request.maxSources) break;
    } catch {
      event(job, 'warning', {message: '一个 B站搜索页面无法读取，已保留进度并继续其他搜索。'});
    }
  }
  if (attemptedSearches && !successfulSearches && !candidates.length && job.directive === 'continue'
    && remaining(job) >= 20_000) throw new Error('搜索暂时不可用，请稍后继续采集。');
}
/** A malformed snapshot must never trigger tab activation or become a committed source. */
function decodeSnapshot(snapshot: ContentSnapshot, candidate: CandidateContent) {
  if (!snapshot || typeof snapshot.title !== 'string' || snapshot.title.length > 2000 || typeof snapshot.description !== 'string'
    || snapshot.description.length > 20_000 || !navigationTargetMatches(candidate.url, snapshot.resolvedUrl)
    || !Array.isArray(snapshot.comments) || snapshot.comments.length > 80
    || !['loaded', 'empty', 'not_ready', 'verification_required'].includes(snapshot.commentState)
    || (snapshot.commentState === 'loaded' && snapshot.comments.length === 0)
    || (snapshot.commentState === 'empty' && snapshot.comments.length !== 0)) throw new ContentReadError('invalid_snapshot', 'snapshot');
  return snapshot;
}
/** Retry delayed rendering in one owned tab, restoring selection only while we still hold it. */
function foregroundSnapshot(job: Job, id: number, candidate: CandidateContent): Promise<ContentSnapshot> {
  const operation = foregroundQueue.catch(() => undefined).then(async () => {
    const mayContinue = () => active === job && !job.disconnected && job.directive === 'continue' && remaining(job) > 0;
    if (!mayContinue() || foregroundExecution) throw new ContentReadError('not_ready');
    const expected = owned.get(id);
    if (!expected || expected.windowId === undefined) throw new ContentReadError('ownership_changed', 'foreground');
    let previousId: number | undefined;
    let activationAttempted = false;
    let selectionChanged = false;
    const selection = (info: {tabId: number; windowId: number}) => {
      if (info.windowId === expected.windowId && info.tabId !== id) selectionChanged = true;
    };
    chrome.tabs.onActivated.addListener(selection);
    try {
      const previous = await chrome.tabs.query({active: true, windowId: expected.windowId});
      previousId = previous.length === 1 ? previous[0].id : undefined;
      if (!ownsDocument(await chrome.tabs.get(id), expected)) throw new ContentReadError('ownership_changed', 'foreground');
      if (!mayContinue() || foregroundExecution) throw new ContentReadError('not_ready');
      event(job, 'state', {state: 'collecting', message: '评论仍在加载，正在依次切换调查标签页完成页面读取…'});
      activationAttempted = true;
      await chrome.tabs.update(id, {active: true});
      const current = await chrome.tabs.get(id);
      if (!ownsDocument(current, expected)) throw new ContentReadError('ownership_changed', 'foreground');
      if (!current.active) throw new ContentReadError('foreground_activation_failed', 'foreground');
      if (!mayContinue()) throw new ContentReadError('not_ready');
      const snapshot = decodeSnapshot(await execute<ContentSnapshot>(id, readContentPage, [], 'MAIN', (native) => {
        foregroundExecution = native;
        const release = () => {if (foregroundExecution === native) foregroundExecution = undefined;};
        void native.then(release, release);
      }), candidate);
      if (!ownsDocument(await chrome.tabs.get(id), expected)) throw new ContentReadError('ownership_changed', 'foreground');
      return snapshot;
    } catch (error) {
      if (error instanceof ContentReadError) throw error;
      throw new ContentReadError('foreground_activation_failed', 'foreground');
    } finally {
      if (!selectionChanged && activationAttempted && previousId !== undefined && previousId !== id) {
        try {
          const selected = await chrome.tabs.query({active: true, windowId: expected.windowId});
          if (selected.length === 1 && selected[0].id === id && ownsDocument(selected[0], expected)) {
            const previous = await chrome.tabs.get(previousId);
            const current = await chrome.tabs.query({active: true, windowId: expected.windowId});
            if (!selectionChanged && previous.windowId === expected.windowId && current.length === 1 && current[0].id === id
              && ownsDocument(current[0], expected)) await chrome.tabs.update(previousId, {active: true});
          }
        } catch { /* A closed or moved prior tab is never replaced with another selection. */ }
      }
      chrome.tabs.onActivated.removeListener(selection);
    }
  });
  foregroundQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
async function content(job: Job, tabId: number, candidate: CandidateContent) {
  await navigate(tabId, candidate.url);
  let snapshot = decodeSnapshot(await execute<ContentSnapshot>(tabId, readContentPage, [], 'MAIN'), candidate);
  if (snapshot.commentState === 'not_ready') snapshot = await foregroundSnapshot(job, tabId, candidate);
  if (snapshot.commentState === 'not_ready' || snapshot.commentState === 'verification_required') {
    throw new ContentReadError(snapshot.commentState);
  }
  const collectedAt = new Date().toISOString();
  const publishedAt = snapshot.publishedAt && Number.isFinite(Date.parse(snapshot.publishedAt)) ? new Date(snapshot.publishedAt).toISOString() : candidate.publishedAt;
  const record: ContentRecord = {...candidate, recordSchemaVersion: 2, runId: job.manifest.id,
    title: snapshot.title || candidate.title, description: snapshot.description, publishedAt, collectedAt,
    resolvedUrl: snapshot.resolvedUrl, metrics: {}};
  const previousCreatorId = await stableBrowserId(candidate.id, 'creator', candidate.title);
  const opinions: OpinionRecord[] = job.checkpoint.seenOpinionIds.includes(previousCreatorId) ? [] : [{id: await stableBrowserId(candidate.id, 'creator', record.title),
    recordSchemaVersion: 2, runId: job.manifest.id, contentId: candidate.id, contentType: candidate.type,
    sourceType: 'creator_view', voiceType: 'creator', text: record.title, publishedAt, collectedAt, likes: 0, replies: 0,
    sourcePageUrl: candidate.url, sourceUrl: candidate.url}];
  let acceptedViewerOpinions = 0;
  for (const item of snapshot.comments) {
    if (!item || typeof item.text !== 'string' || item.text.length < 3 || item.text.length > 1200
      || !Number.isSafeInteger(item.likes) || item.likes < 0 || !Number.isSafeInteger(item.replies) || item.replies < 0) continue;
    const publicId = (value: unknown) => typeof value === 'string' && /^\d{1,32}$/.test(value) ? value : undefined;
    const sourceRecordId = publicId(item.sourceRecordId);
    const parentSourceRecordId = publicId(item.parentSourceRecordId);
    const authorUid = publicId(item.authorUid);
    const authorName = typeof item.authorName === 'string' ? item.authorName.slice(0, 200) : undefined;
    const sourceType = item.isReply || parentSourceRecordId ? 'reply' : 'comment';
    const url = new URL(candidate.url);
    if (sourceRecordId) {
      url.searchParams.set('comment_on', '1');
      url.searchParams.set('comment_root_id', parentSourceRecordId || sourceRecordId);
      if (parentSourceRecordId && parentSourceRecordId !== sourceRecordId) url.searchParams.set('comment_secondary_id', sourceRecordId);
    }
    const epoch = item.publishedAtEpochSeconds;
    const opinionDate = typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0 && epoch < 10_000_000_000
      ? new Date(epoch * 1000).toISOString() : commentTime(item.publishedAtText, collectedAt);
    opinions.push({id: await stableBrowserId(candidate.id, sourceType, sourceRecordId || authorUid || authorName || 'anonymous', ...(sourceRecordId ? [] : [item.text])),
      recordSchemaVersion: 2, runId: job.manifest.id, contentId: candidate.id, contentType: candidate.type,
      sourceType, voiceType: 'viewer', text: item.text, publishedAt: opinionDate,
      publishedAtText: typeof item.publishedAtText === 'string' ? item.publishedAtText.slice(0, 100) : undefined,
      collectedAt, authorUid, authorName, authorProfileUrl: authorUid ? `https://space.bilibili.com/${authorUid}` : undefined,
      sourceRecordId, parentSourceRecordId, likes: item.likes, replies: item.replies, sourcePageUrl: candidate.url, sourceUrl: url.toString()});
    acceptedViewerOpinions += 1;
  }
  if (snapshot.commentState === 'loaded' && acceptedViewerOpinions === 0) throw new ContentReadError('no_valid_comments', 'comments');
  return {record, opinions, commentState: snapshot.commentState};
}
async function collect(job: Job) {
  let commitQueue = Promise.resolve();
  const claimed = new Set<string>();
  let outcome: 'paused' | 'finalized' | 'budget_exhausted' | 'source_exhausted' = 'source_exhausted';
  try {
    const first = await toolTab(job.group, job);
    await discover(job, first);
    event(job, 'state', {state: 'collecting', message: `正在使用 ${job.manifest.request.browserWindowCount} 个调查标签页采集公开意见…`});
    const count = Math.min(job.manifest.request.browserWindowCount, Math.max(1, job.checkpoint.pendingCandidates.length));
    const tabs = [first];
    for (let index = 1; index < count && job.directive === 'continue'; index += 1) tabs.push(await toolTab(job.group, job));
    await Promise.all(tabs.map(async (tabId) => {
      while (job.directive === 'continue' && remaining(job) > 0) {
        const candidate = job.checkpoint.pendingCandidates.find((item) => !claimed.has(item.id));
        if (!candidate) break;
        claimed.add(candidate.id);
        let collected: Awaited<ReturnType<typeof content>> | undefined;
        try { collected = await content(job, tabId, candidate); }
        catch (error) {
          const reason: CollectionWarningReason = error instanceof ContentReadError ? error.reason : 'extraction_error';
          const stage: CollectionReadStage = error instanceof ContentReadError ? error.stage : 'collection';
          event(job, 'warning', {message: collectionWarningMessages[reason], details: {contentId: candidate.id, stage, reason}});
        }
        const commit = commitQueue.then(() => {
          const eligible = collected && (!collected.record.publishedAt || Date.parse(collected.record.publishedAt) >= Date.now() - job.manifest.request.contentWindowDays * 86_400_000);
          if (collected && eligible) {
            event(job, 'content', collected.record);
            for (const opinion of collected.opinions) if (!job.checkpoint.seenOpinionIds.includes(opinion.id)) {
              event(job, 'opinion', opinion);
              job.checkpoint.seenOpinionIds.push(opinion.id);
            }
            if (collected.commentState === 'empty') event(job, 'warning', {
              message: '该来源显示暂无评论，已保留来源记录。',
              details: {contentId: candidate.id}
            });
          }
          if (collected) {
            if (eligible && !job.checkpoint.seenContentIds.includes(candidate.id)) job.checkpoint.seenContentIds.push(candidate.id);
            job.checkpoint.pendingCandidates = job.checkpoint.pendingCandidates.filter((item) => item.id !== candidate.id);
          }
          checkpoint(job);
        });
        commitQueue = commit.catch(() => undefined);
        await commit;
        // Failed candidates stay pending for an explicit retry without a hot loop.
      }
    }));
    await commitQueue;
    outcome = job.directive === 'pause' || job.disconnected ? 'paused' : job.directive === 'finalize' ? 'finalized'
      : remaining(job) === 0 ? 'budget_exhausted' : job.checkpoint.pendingCandidates.length ? 'paused' : 'source_exhausted';
  } catch {
    outcome = job.directive === 'finalize' ? 'finalized' : 'paused';
    event(job, 'warning', {message: '采集已暂停，已保存的本地记录可以继续采集或直接生成报告。'});
  } finally {
    checkpoint(job);
    const cleanup = await Promise.allSettled([...job.owned].map(closeOwned));
    if (cleanup.some((item) => item.status === 'rejected')) event(job, 'warning', {message: '部分调查标签页清理未完成，请手动关闭工具创建的标签页。'});
    if (active === job) active = undefined;
    event(job, 'complete', {outcome, checkpoint: structuredClone(job.checkpoint)});
  }
}
async function dispatch(port: Port, method: string, payload: unknown) {
  await initialized;
  if (method === 'status') return status();
  if (method === 'connect') {
    if (active) throw new Error('调查正在采集，请先暂停后再检查登录。');
    await connectionSummary(await checkLogin());
    return status();
  }
  if (method === 'disconnect') {
    if (active) throw new Error('调查正在采集，请先暂停后再断开。');
    await connectionSummary({loginState: 'logged_out'});
    return status();
  }
  if (method === 'pause' || method === 'finalize') {
    const runId = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).runId : undefined;
    if (!active || active.port !== port || active.manifest.id !== runId) throw new Error('该页面没有正在运行的调查。');
    active.directive = method === 'pause' ? 'pause' : 'finalize';
    return {accepted: true};
  }
  if (method === 'start' || method === 'resume') {
    if (active) throw new Error('浏览器扩展已有调查正在运行，请先暂停。');
    const input = collectionInput(payload);
    if (input.checkpoint.activeElapsedMs >= input.manifest.request.durationMinutes * 60_000) throw new Error('采集时间已经用完，请增加时间或生成报告。');
    await connectionSummary(await checkLogin());
    if (!connected) throw new Error('请在自己的 Chrome 中登录 B站后重新连接。');
    if (!livePorts.has(port)) throw new Error('调查页面已关闭，请重新打开页面后继续。');
    const job: Job = {...input, port, directive: 'continue', startedAt: Date.now(), baseElapsedMs: input.checkpoint.activeElapsedMs,
      owned: new Set(), group: {}, disconnected: false};
    active = job;
    // Promise rejection is handled here; no provider or page payload is logged.
    void collect(job).catch(() => { if (active === job) active = undefined; });
    return {accepted: true};
  }
  throw new Error('扩展不支持此操作。');
}

/** Every privileged command is bound to one approved top-level portal document. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CHANNEL || port.sender?.id !== chrome.runtime.id || port.sender.frameId !== 0
    || port.sender.tab?.id === undefined || !isPortalUrl(port.sender.url || '')) { port.disconnect(); return; }
  livePorts.add(port);
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    livePorts.delete(port);
    if (active?.port === port) { active.disconnected = true; active.directive = 'pause'; }
  });
  port.onMessage.addListener((value) => {
    if (!isExtensionRequest(value)) return;
    const operation = commandQueue.catch(() => undefined).then(async () => {
      if (disconnected) return;
      const tab = await chrome.tabs.get(port.sender!.tab!.id!);
      if (!tab.url || !isPortalUrl(tab.url)) throw new Error('该页面无权使用调查扩展。');
      const result = await dispatch(port, value.method, value.payload);
      if (!disconnected) port.postMessage({channel: CHANNEL, direction: 'response', id: value.id, result});
    });
    commandQueue = operation.catch(() => undefined);
    void operation.catch((error: unknown) => {
      if (!disconnected) try { port.postMessage({channel: CHANNEL, direction: 'response', id: value.id,
        error: error instanceof Error ? error.message : '扩展操作失败，请稍后重试。'}); } catch { /* The portal was closed. */ }
    });
  });
});
