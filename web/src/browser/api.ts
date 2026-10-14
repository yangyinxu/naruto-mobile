import type {AppSettings, ChromeConnectionStatus, KeywordSettings, ResearchRequest, RunManifest, RunRecordsResponse} from '../types';
import {ACCOUNT_URL, BrowserAnalysisSession, LOGIN_URL} from './auth';
import {decodeRunArchive, encodeRunArchive} from './archive';
import {ChromeExtensionBridge} from './bridge';
import {BrowserResearchRuntime} from './runtime';
import {BrowserRunStore, LOCAL_DATA_DESCRIPTION} from './store';
import {object, text} from './validation';

const defaultKeywords = ['火影忍者手游'];
const defaults: AppSettings['defaults'] = {durationMinutes: 5, contentWindowDays: 30, keywords: defaultKeywords,
  includeVideos: true, includeDynamics: true, mode: 'live', browserVisible: true, browserWindowCount: 4,
  maxSources: 20, useKeywordPrefix: true};
let singleton: BrowserResearchRuntime | undefined;

/** Initialize lazily so the desktop bundle keeps its original localhost API path. */
export const browserRuntime = () => singleton ??= new BrowserResearchRuntime(new BrowserRunStore(),
  new ChromeExtensionBridge(window), new BrowserAnalysisSession(fetch, window), undefined, window);

const decodeChromeStatus = (value: unknown): ChromeConnectionStatus => {
  const status = object(value);
  if (!['not_ready', 'ready', 'connecting', 'disconnecting', 'connected', 'error'].includes(String(status.state))
    || typeof status.connected !== 'boolean' || !['unknown', 'logged_in', 'logged_out'].includes(String(status.loginState))
    || typeof status.activeInvestigations !== 'number' || !Number.isSafeInteger(status.activeInvestigations)
    || status.activeInvestigations < 0) throw new Error('Chrome 扩展状态格式不正确，请更新扩展。');
  return {state: status.state as ChromeConnectionStatus['state'], connected: status.connected,
    remoteDebuggingEnabled: false, loginState: status.loginState as ChromeConnectionStatus['loginState'],
    activeInvestigations: status.activeInvestigations, message: text(status.message, 1000),
    ...(typeof status.accountName === 'string' ? {accountName: text(status.accountName, 200)} : {}),
    ...(typeof status.accountUidSuffix === 'string' ? {accountUidSuffix: text(status.accountUidSuffix, 20)} : {})};
};

/** Ask Chromium to download a local blob; no raw archive ever leaves this browser. */
const downloadArchive = (bytes: Uint8Array, filename: string) => {
  const blob = new Blob([new Uint8Array(bytes)], {type: 'application/zip'});
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor);
  try {anchor.click();} finally {anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);}
};

export const browserApi = {
  settings: async (): Promise<AppSettings> => {
    const runtime = browserRuntime();
    await runtime.initialize();
    const keywords = await runtime.store.getSetting<KeywordSettings>('keywords');
    // A transient service error must not hide local reports or prevent ZIP backups.
    const [status] = await Promise.allSettled([runtime.analysis.status(), runtime.analysis.account()]);
    // Re-read the current identity after both requests: an intervening transition may have cleared it.
    const account = runtime.analysis.currentAccount;
    const configured = status.status === 'fulfilled' ? status.value.enabled : runtime.analysis.serviceEnabled ?? false;
    return {apiVersion: 11, runtime: 'browser', dataRoot: LOCAL_DATA_DESCRIPTION, dataRootLocked: true,
      defaults: {...defaults, ...(keywords ?? {})}, analysis: {aiConfigured: configured && Boolean(account),
        loginRequired: !account, account, transport: 'proxy', model: 'gpt-6-luna', reasoningEffort: 'medium',
        maxConcurrentRequests: 12, batchSize: 10, liveMode: 'ai', demoMode: 'rule_demo'}};
  },
  saveKeywords: async (value: KeywordSettings): Promise<KeywordSettings> => {
    if (!Array.isArray(value.keywords) || !value.keywords.length || value.keywords.length > 12
      || value.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim() || keyword.length > 40)
      || typeof value.useKeywordPrefix !== 'boolean') throw new Error('关键词设置格式不正确。');
    const settings = {keywords: [...new Set(value.keywords.map((keyword) => keyword.trim()))], useKeywordPrefix: value.useKeywordPrefix};
    await browserRuntime().store.setSetting('keywords', settings);
    return settings;
  },
  loginAnalysis: async (_identifier: string, _password: string): Promise<never> => {
    window.location.assign(LOGIN_URL);
    // The hosted UI uses a link, so there is no fabricated account result while navigation runs.
    return new Promise<never>(() => undefined);
  },
  logoutAnalysis: async (): Promise<void> => {window.location.assign(ACCOUNT_URL);},
  selectDataRoot: async () => ({dataRoot: LOCAL_DATA_DESCRIPTION, cancelled: true}),
  listRuns: () => browserRuntime().list(),
  importRun: async (file: File) => {
    if (!file.size || file.size > 128 * 1024 * 1024) throw new Error('请选择不超过 128 MiB 的调查 ZIP 文件。');
    const run = decodeRunArchive(new Uint8Array(await file.arrayBuffer()));
    await browserRuntime().store.create(run);
    return run.manifest;
  },
  exportRun: async (id: string): Promise<void> => {
    const runtime = browserRuntime();
    await runtime.initialize();
    const release = await runtime.locks.acquire(id);
    try {
      const run = await runtime.store.get(id);
      run.manifest = await runtime.get(id);
      const filename = `${run.manifest.request.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80) || '调查记录'}-${id}.zip`;
      downloadArchive(encodeRunArchive(run), filename);
    } finally {release();}
  },
  runDetail: async (id: string) => {
    const runtime = browserRuntime(), manifest = await runtime.get(id), run = await runtime.store.get(id);
    return {run: manifest, events: run.events};
  },
  runRecords: (id: string, kind: 'opinions' | 'contents', offset: number, limit: number, query = ''): Promise<RunRecordsResponse> =>
    browserRuntime().records(id, kind, offset, limit, query) as Promise<RunRecordsResponse>,
  startRun: (request: ResearchRequest) => browserRuntime().start(request),
  pause: (id: string) => browserRuntime().pause(id),
  resume: (id: string) => browserRuntime().resume(id),
  finalize: (id: string) => browserRuntime().finalize(id),
  reanalyze: (id: string) => browserRuntime().reanalyze(id),
  extend: (id: string, minutes: number) => browserRuntime().extend(id, minutes),
  openFolder: async (_id: string): Promise<{ok: boolean}> => {
    throw new Error('浏览器调查保存在当前 Chrome 的本机存储中。请使用“导出调查”下载 ZIP，不能直接打开系统文件夹。');
  },
  openChromeSettings: async () => ({ok: false, url: '/naruto/#extension-guide'}),
  chromeStatus: async (): Promise<ChromeConnectionStatus> => {
    try {return decodeChromeStatus(await browserRuntime().bridge.request('status'));}
    catch (error) {return {state: 'not_ready', connected: false, remoteDebuggingEnabled: false, loginState: 'unknown',
      activeInvestigations: 0, message: error instanceof Error ? error.message : '请安装并启用 Chrome 扩展。'};}
  },
  connectChrome: async () => decodeChromeStatus(await browserRuntime().bridge.request('connect')),
  disconnectChrome: async () => decodeChromeStatus(await browserRuntime().bridge.request('disconnect')),
  report: async (id: string) => {
    const run = await browserRuntime().store.get(id);
    if (!run.manifest.reportReady || run.report === undefined) throw new Error('报告尚未生成，请继续分析。');
    return run.report;
  },
  reportData: (id: string) => browserRuntime().reportData(id)
};

/** Synchronous unsubscribe matches the React hook contract while initial IndexedDB loading is async. */
export const subscribeRun = (id: string, listener: (manifest: RunManifest) => void): (() => void) =>
  browserRuntime().subscribe(id, listener);
