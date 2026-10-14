import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import App from './App';
import {api} from './lib/api';
import type {AppSettings} from './types';

vi.mock('./lib/api', () => ({api: {settings: vi.fn(), listRuns: vi.fn(), chromeStatus: vi.fn(), startRun: vi.fn()}}));

const settings = (userId: string): AppSettings => ({apiVersion: 11, runtime: 'browser', dataRoot: '当前浏览器本地存储',
  analysis: {aiConfigured: true, transport: 'proxy', model: 'gpt-6-luna', reasoningEffort: 'medium', liveMode: 'ai', demoMode: 'rule_demo',
    account: {userId, email: `${userId}@example.test`, role: 'user'}},
  defaults: {durationMinutes: 5, contentWindowDays: 30, keywords: ['火影忍者手游'], includeVideos: true,
    includeDynamics: true, mode: 'live', browserVisible: true, browserWindowCount: 4, maxSources: 20}});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MODE', 'hosted');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.mocked(api.listRuns).mockResolvedValue([]);
  vi.mocked(api.chromeStatus).mockResolvedValue({state: 'connected', connected: true, remoteDebuggingEnabled: false,
    loginState: 'logged_in', activeInvestigations: 0, message: 'B站已登录，可以开始调查。'});
});
afterEach(() => {vi.unstubAllEnvs(); vi.restoreAllMocks();});

describe('hosted displayed account transitions', () => {
  it('clears the old account immediately and rejects a late settings refresh after a failed start', async () => {
    let resolveOld!: (value: AppSettings) => void, resolveNew!: (value: AppSettings) => void;
    const oldRefresh = new Promise<AppSettings>(resolve => {resolveOld = resolve;});
    const newRefresh = new Promise<AppSettings>(resolve => {resolveNew = resolve;});
    vi.mocked(api.settings).mockResolvedValueOnce(settings('account-A'))
      .mockReturnValueOnce(oldRefresh).mockReturnValueOnce(newRefresh);
    vi.mocked(api.startRun).mockRejectedValue(new Error('Synthetic start failure'));
    render(<App/>);
    expect(await screen.findByText('account-A@example.test · 登录有效')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', {name: /开始调查/})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    await waitFor(() => expect(api.settings).toHaveBeenCalledTimes(2));
    act(() => {window.dispatchEvent(new CustomEvent('naruto:analysis-account-change'));});
    expect(screen.queryByText('account-A@example.test · 登录有效')).not.toBeInTheDocument();
    expect(screen.getByRole('link', {name: '前往 Archtree 登录'})).toBeVisible();
    await act(async () => {resolveNew(settings('account-B')); await newRefresh;});
    expect(await screen.findByText('account-B@example.test · 登录有效')).toBeVisible();
    await act(async () => {resolveOld(settings('account-A')); await oldRefresh;});
    expect(screen.getByText('account-B@example.test · 登录有效')).toBeVisible();
    expect(screen.queryByText('account-A@example.test · 登录有效')).not.toBeInTheDocument();
  });
});
