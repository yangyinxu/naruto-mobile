import {
  AppSettings,
  ChromeConnectionStatus,
  KeywordSettings,
  ReportData,
  ResearchRequest,
  RunEvent,
  RunManifest,
  RunRecordsResponse
} from '../types';
import {browserApi} from '../browser/api';

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {'Content-Type': 'application/json', ...init?.headers}
  });
  const value = await response.json().catch(() => ({})) as {message?: string};
  if (!response.ok) throw new Error(value.message || '操作失败，请稍后重试。');
  return value as T;
};

const archiveError = async (response: Response, fallback: string): Promise<Error> => {
  const value = await response.json().catch(() => ({})) as {message?: unknown};
  return new Error(typeof value.message === 'string' && value.message ? value.message : fallback);
};

const archiveFilename = (header: string | null): string => {
  let name = '';
  const utf8 = header?.match(/filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i)?.[1];
  if (utf8) {
    try { name = decodeURIComponent(utf8.trim().replace(/^"|"$/g, '')); } catch { /* Use the plain filename or fallback. */ }
  }
  if (!name) name = header?.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)?.trim() || '调查记录.zip';
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[.\s]+$/g, '');
  return name.toLowerCase().endsWith('.zip') ? name : `${name || '调查记录'}.zip`;
};

const desktopApi = {
  settings: () => request<AppSettings>('/api/settings'),
  saveKeywords: (settings: KeywordSettings) => request<KeywordSettings>('/api/settings/keywords', {
    method: 'PUT', body: JSON.stringify(settings)
  }),
  loginAnalysis: (identifier: string, password: string) => request<{
    signedIn: true;
    account: {userId: string; email: string; role: 'admin' | 'user'};
  }>(
    '/api/analysis/login',
    {method: 'POST', body: JSON.stringify({identifier, password})}
  ),
  logoutAnalysis: () => request<void>('/api/analysis/logout', {method: 'POST'}),
  selectDataRoot: () => request<{dataRoot: string; previousDataRoot?: string; cancelled: boolean}>(
    '/api/settings/select-data-root',
    {method: 'POST'}
  ),
  listRuns: async () => (await request<{runs: RunManifest[]}>('/api/runs')).runs,
  importRun: async (file: File): Promise<RunManifest> => {
    const response = await fetch('/api/runs/import', {
      method: 'POST', headers: {'Content-Type': 'application/zip'}, body: file
    });
    if (!response.ok) throw await archiveError(response, '导入失败，请选择本工具导出的调查 ZIP 文件。');
    const value = await response.json() as {run: RunManifest; originalRunId: string};
    return value.run;
  },
  exportRun: async (id: string): Promise<void> => {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}/archive`);
    if (!response.ok) throw await archiveError(response, '导出失败，请稍后重试。');
    const blob = await response.blob();
    if (!blob.size) throw new Error('导出的压缩包为空，请稍后重试。');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = archiveFilename(response.headers.get('Content-Disposition'));
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      // Keep the blob available while Chromium hands the download to its save dialog.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  },
  runDetail: (id: string) => request<{run: RunManifest; events: RunEvent[]}>(`/api/runs/${id}`),
  runRecords: (
    id: string,
    kind: 'opinions' | 'contents',
    offset: number,
    limit: number,
    query = ''
  ) => {
    const search = new URLSearchParams({kind, offset: String(offset), limit: String(limit)});
    if (query) search.set('q', query);
    return request<RunRecordsResponse>(`/api/runs/${id}/records?${search.toString()}`);
  },
  startRun: async (settings: ResearchRequest) => (
    await request<{run: RunManifest}>('/api/runs', {method: 'POST', body: JSON.stringify(settings)})
  ).run,
  pause: async (id: string) => (
    await request<{run: RunManifest}>(`/api/runs/${id}/pause`, {method: 'POST'})
  ).run,
  resume: async (id: string) => (
    await request<{run: RunManifest}>(`/api/runs/${id}/resume`, {method: 'POST'})
  ).run,
  finalize: async (id: string) => (
    await request<{run: RunManifest}>(`/api/runs/${id}/finalize`, {method: 'POST'})
  ).run,
  reanalyze: async (id: string) => (
    await request<{run: RunManifest}>(`/api/runs/${id}/reanalyze`, {method: 'POST'})
  ).run,
  extend: async (id: string, minutes: number) => (
    await request<{run: RunManifest}>(`/api/runs/${id}/extend`, {
      method: 'POST', body: JSON.stringify({minutes})
    })
  ).run,
  openFolder: (id: string) => request<{ok: boolean}>(`/api/runs/${id}/open-folder`, {method: 'POST'}),
  openChromeSettings: () => request<{ok: boolean; url: string}>('/api/chrome/open-remote-debugging', {method: 'POST'}),
  chromeStatus: async () => (
    await request<{chrome: ChromeConnectionStatus}>('/api/chrome/status')
  ).chrome,
  connectChrome: async () => (
    await request<{chrome: ChromeConnectionStatus}>('/api/chrome/connect', {method: 'POST'})
  ).chrome,
  disconnectChrome: async () => (
    await request<{chrome: ChromeConnectionStatus}>('/api/chrome/disconnect', {method: 'POST'})
  ).chrome,
  report: async (id: string) => {
    const response = await fetch(`/api/runs/${id}/report`);
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as {message?: string};
      throw new Error(value.message || '报告暂时无法读取。');
    }
    return response.text();
  },
  reportData: async (id: string) => (
    await request<{report: ReportData}>(`/api/runs/${id}/report-data`)
  ).report
};

/** Hosted builds run on this device; desktop builds continue using the local service. */
export const api: typeof desktopApi = import.meta.env.MODE === 'hosted' ? browserApi : desktopApi;
