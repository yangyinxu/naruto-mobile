import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {ChromeConnectionStatus} from '../types';
import {NewResearch} from './NewResearch';

const settings = {
  apiVersion: 5,
  dataRoot: 'D:/Research/naruto-mobile',
  analysis: {
    aiConfigured: true,
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
    liveMode: 'ai' as const,
    demoMode: 'rule_demo' as const
  },
  defaults: {
    durationMinutes: 5,
    contentWindowDays: 30,
    keywords: ['火影忍者手游'],
    includeVideos: true,
    includeDynamics: true,
    mode: 'live' as const,
    browserVisible: true,
    browserWindowCount: 1,
    maxSources: 20
  }
};

const chromeProps = () => ({
  chromeStatus: {
    state: 'connected' as const,
    remoteDebuggingEnabled: true,
    connected: true,
    loginState: 'logged_in' as const,
    accountName: '测试玩家',
    accountUidSuffix: '1234',
    activeInvestigations: 0,
    message: 'Chrome 已连接。'
  },
  connectingChrome: false,
  onConnectChrome: vi.fn().mockResolvedValue(undefined),
  onDisconnectChrome: vi.fn().mockResolvedValue(undefined)
});

describe('NewResearch', () => {
  it('starts with the beginner five-minute preset and submits canonical settings', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByText(/Luna 筛选强洞察/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      durationMinutes: 5,
      contentWindowDays: 30,
      mode: 'live'
    }));
  });

  it('allows a beginner to enter a custom collection duration', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('最长采集时长（分钟）'), {target: {value: '17'}});
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({durationMinutes: 17}));
  });

  it('shows advanced mode options without requiring expansion', () => {
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByText('高级选项')).toBeVisible();
    expect(screen.getByText(/真实调查 · Luna AI/)).toBeVisible();
    expect(screen.getByText('本地演示')).toBeVisible();
    expect(screen.getByLabelText('并行调查标签页数')).toBeVisible();
  });

  it('submits the selected live browser concurrency', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('并行调查标签页数'), {target: {value: '3'}});
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({browserWindowCount: 3}));
  });

  it('lets the user control the source limit instead of applying a hidden cap', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('最长采集时长（分钟）'), {target: {value: '3'}});
    fireEvent.change(screen.getByLabelText('最多采集来源数'), {target: {value: '60'}});
    expect(screen.getByText(/达到 3 分钟.*处理完 60 个来源/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({durationMinutes: 3, maxSources: 60}));
  });

  it('puts the beginner Chrome guide in a prominent position', () => {
    const onOpenGuide = vi.fn();
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={onOpenGuide}/>);
    fireEvent.click(screen.getByRole('button', {name: /图文教程/}));
    expect(onOpenGuide).toHaveBeenCalledOnce();
    expect(screen.getByText(/工具只操作自己创建的调查标签页/)).toBeInTheDocument();
  });

  it('requires a logged-in Chrome connection for live research but not demo mode', () => {
    const disconnectedStatus: ChromeConnectionStatus = {
      ...chromeProps().chromeStatus,
      state: 'ready',
      connected: false,
      loginState: 'unknown',
      accountName: undefined,
      accountUidSuffix: undefined,
      message: 'Chrome 已准备好。'
    };
    render(<NewResearch {...chromeProps()} chromeStatus={disconnectedStatus} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByRole('button', {name: /连接 Chrome 后开始/})).toBeDisabled();
    fireEvent.click(screen.getByText('本地演示'));
    expect(screen.getByRole('button', {name: /^开始调查/})).toBeEnabled();
  });

  it('locks connection actions until Chrome has completely disconnected', () => {
    const disconnectingStatus: ChromeConnectionStatus = {
      ...chromeProps().chromeStatus,
      state: 'disconnecting',
      message: '正在安全断开 Chrome，请稍候。'
    };
    render(<NewResearch {...chromeProps()} chromeStatus={disconnectingStatus} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByRole('button', {name: /正在断开 Chrome/})).toBeDisabled();
    expect(screen.getByRole('button', {name: /^断开$/})).toBeDisabled();
    expect(screen.getByRole('button', {name: /连接 Chrome 后开始/})).toBeDisabled();
  });

  it('lets the user open the native data location picker', () => {
    const onSelectDataRoot = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={onSelectDataRoot} onOpenGuide={vi.fn()}/>);
    expect(screen.getByText(settings.dataRoot)).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: /选择存放位置/}));
    expect(onSelectDataRoot).toHaveBeenCalledOnce();
    expect(screen.getByText(/不会移动原文件/)).toBeVisible();
  });

  it('logs into any Archtree account without exposing an OpenAI key', async () => {
    const onLoginAnalysis = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch
      {...chromeProps()}
      settings={{...settings, analysis: {...settings.analysis, aiConfigured: false, loginRequired: true, transport: 'proxy'}}}
      busy={false}
      selectingDataRoot={false}
      onStart={vi.fn()}
      onSelectDataRoot={vi.fn()}
      onLoginAnalysis={onLoginAnalysis}
      onOpenGuide={vi.fn()}
    />);
    expect(screen.getByRole('button', {name: /登录 Archtree 后开始/})).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Archtree 邮箱或用户名'), {target: {value: 'friend@example.com'}});
    fireEvent.change(screen.getByLabelText('Archtree 密码'), {target: {value: 'private-password'}});
    fireEvent.click(screen.getByRole('button', {name: /^登录$/}));
    await vi.waitFor(() => expect(onLoginAnalysis).toHaveBeenCalledWith('friend@example.com', 'private-password'));
    expect(screen.queryByText(/OpenAI API 密钥/)).not.toBeInTheDocument();
  });

  it('shows the signed-in Archtree account and can log out', async () => {
    const onLogoutAnalysis = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch
      {...chromeProps()}
      settings={{...settings, analysis: {
        ...settings.analysis,
        transport: 'proxy',
        account: {userId: '64b000000000000000000001', email: 'friend@example.com', role: 'user'}
      }}}
      busy={false}
      selectingDataRoot={false}
      onStart={vi.fn()}
      onSelectDataRoot={vi.fn()}
      onLogoutAnalysis={onLogoutAnalysis}
      onOpenGuide={vi.fn()}
    />);
    expect(screen.getByText('friend@example.com · 登录有效')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: /退出或更换账号/}));
    await vi.waitFor(() => expect(onLogoutAnalysis).toHaveBeenCalledOnce());
  });
});
