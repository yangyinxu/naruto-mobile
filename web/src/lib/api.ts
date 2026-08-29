import {
  AppSettings,
  ChromeConnectionStatus,
  ReportData,
  ResearchRequest,
  RunEvent,
  RunManifest,
  RunRecordsResponse
} from '../types';

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {'Content-Type': 'application/json', ...init?.headers}
  });
  const value = await response.json().catch(() => ({})) as {message?: string};
  if (!response.ok) throw new Error(value.message || '操作失败，请稍后重试。');
  return value as T;
};

export const api = {
  settings: () => request<AppSettings>('/api/settings'),
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
