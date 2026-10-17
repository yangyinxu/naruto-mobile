import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {ExtensionGuide} from './ExtensionGuide';
import {latestExtensionVersion} from '../browser/extensionVersion';

describe('ExtensionGuide', () => {
  it('explains local data backup and provides the actual extension package', () => {
    render(<ExtensionGuide connectingChrome={false} onBack={vi.fn()} onConnectChrome={vi.fn()} onDisconnectChrome={vi.fn()}/>);
    const download = screen.getByRole('link', {name: `下载 Chrome 扩展 ${latestExtensionVersion}`});
    expect(download).toHaveAttribute('href', `${import.meta.env.BASE_URL}naruto-mobile-chrome-extension.zip`);
    expect(download).toHaveAttribute('download', `naruto-mobile-chrome-extension-${latestExtensionVersion}.zip`);
    expect(screen.getByDisplayValue('chrome://extensions')).toBeVisible();
    expect(screen.getByText(/清除网站数据会删除本地调查/)).toBeVisible();
    expect(screen.getByText(new RegExp(`当前版本 ${latestExtensionVersion}`))).toBeVisible();
    expect(screen.getByText(/后台评论仍未加载时/)).toBeVisible();
    expect(screen.getByText(/采集会新开一个独立 Chrome 窗口/)).toBeVisible();
    expect(screen.getByText(/不再创建标签页组/)).toBeVisible();
    expect(screen.queryByText(/remote-debugging/)).not.toBeInTheDocument();
  });
  it('reports extension connection failure instead of claiming readiness', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('扩展未安装。'));
    render(<ExtensionGuide connectingChrome={false} onBack={vi.fn()} onConnectChrome={connect} onDisconnectChrome={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', {name: '连接扩展并检查 B站'}));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('扩展未安装。'));
    expect(screen.queryByText('B站已登录，可以开始调查。')).not.toBeInTheDocument();
  });
});
