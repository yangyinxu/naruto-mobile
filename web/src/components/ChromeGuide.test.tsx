import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {ChromeGuide} from './ChromeGuide';

const chromeStatus = {
  state: 'ready' as const,
  remoteDebuggingEnabled: true,
  connected: false,
  loginState: 'unknown' as const,
  activeInvestigations: 0,
  message: 'Chrome 已准备好。'
};

describe('ChromeGuide', () => {
  it('shows the complete beginner workflow and opens Chrome settings', async () => {
    const onOpenChromeSettings = vi.fn().mockResolvedValue(undefined);
    render(<ChromeGuide chromeSettingsSupported chromeStatus={chromeStatus} connectingChrome={false} onBack={vi.fn()} onOpenChromeSettings={onOpenChromeSettings} onConnectChrome={vi.fn()} onDisconnectChrome={vi.fn()}/>);

    expect(screen.getByRole('heading', {name: /3 分钟完成 Chrome 连接准备/})).toBeInTheDocument();
    expect(screen.getAllByText('Ctrl', {selector: 'kbd'})).toHaveLength(2);
    expect(screen.getByText(/Allow remote debugging for this browser instance/)).toBeInTheDocument();
    expect(screen.getByText(/不需要填写 9222 或复制 Cookie/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {name: /尝试自动打开设置页/}));
    expect(onOpenChromeSettings).toHaveBeenCalledOnce();
    expect(await screen.findByText(/如果没有看到新页面/)).toBeInTheDocument();
  });

  it('explains how to restart an older local service', () => {
    render(<ChromeGuide chromeSettingsSupported={false} chromeStatus={{...chromeStatus, remoteDebuggingEnabled: false, state: 'not_ready'}} connectingChrome={false} onBack={vi.fn()} onOpenChromeSettings={vi.fn()} onConnectChrome={vi.fn()} onDisconnectChrome={vi.fn()}/>);
    expect(screen.getByRole('button', {name: /重新启动工具后可用/})).toBeDisabled();
    expect(screen.getByText(/关闭旧的 CMD 窗口/)).toBeInTheDocument();
  });
});
