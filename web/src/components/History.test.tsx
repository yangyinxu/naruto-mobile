import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {RunManifest} from '../types';
import {History} from './History';

const run: RunManifest = {
  id: '20260827T120000-abcd1234',
  state: 'completed',
  request: {
    name: '历史记录入口测试',
    durationMinutes: 5,
    contentWindowDays: 30,
    keywords: ['火影忍者手游'],
    includeVideos: true,
    includeDynamics: false,
    mode: 'live',
    browserVisible: true,
    browserWindowCount: 1,
    maxSources: 20
  },
  createdAt: '2026-08-27T12:00:00.000Z',
  updatedAt: '2026-08-27T12:05:00.000Z',
  activeElapsedMs: 300_000,
  statusMessage: '调查和报告已经完成。',
  counts: {candidates: 4, contents: 3, opinions: 12, validOpinions: 10, sources: 3, warnings: 0},
  reportReady: true
};

const renderHistory = (overrides: Partial<React.ComponentProps<typeof History>> = {}) => {
  const props = {
    runs: [run], onOpen: vi.fn(), onBrowse: vi.fn(), onOpenFolder: vi.fn(),
    onImport: vi.fn().mockResolvedValue(run), onExport: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  render(<History {...props}/>);
  return props;
};

const selectFile = (file?: File) => fireEvent.change(screen.getByLabelText('选择调查 ZIP 文件'), {
  target: {files: file ? [file] : []}
});

describe('History', () => {
  it('offers complete record browsing and folder opening for every run', () => {
    const onBrowse = vi.fn();
    const onOpenFolder = vi.fn();
    renderHistory({onBrowse, onOpenFolder});
    expect(screen.getByText('条原始记录')).toBeInTheDocument();
    expect(screen.getByText('最长 5 分钟')).toBeInTheDocument();
    expect(screen.getByText(/清理去重前的评论、回复、弹幕和作者观点合计/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /浏览完整记录/}));
    expect(onBrowse).toHaveBeenCalledWith(run);
    fireEvent.click(screen.getByRole('button', {name: /打开 历史记录入口测试 的完整记录文件夹/}));
    expect(onOpenFolder).toHaveBeenCalledWith(run);
  });

  it('offers import in an empty history and opens the imported record only on request', async () => {
    const props = renderHistory({runs: []});
    expect(screen.getByRole('button', {name: '导入调查'})).toBeEnabled();
    expect(screen.getByText(/导入和查看不需要登录或重新调用 AI/)).toBeInTheDocument();
    const file = new File(['zip'], '十月活动.ZIP', {type: 'application/zip'});
    selectFile(file);
    expect(await screen.findByText(/已导入“历史记录入口测试”/)).toBeInTheDocument();
    expect(props.onImport).toHaveBeenCalledWith(file);
    expect(props.onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '查看导入调查'}));
    expect(props.onOpen).toHaveBeenCalledWith(run);
  });

  it('does nothing when the file dialog is cancelled', () => {
    const props = renderHistory();
    selectFile();
    expect(props.onImport).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('rejects non-ZIP and oversized files before uploading', () => {
    const props = renderHistory();
    selectFile(new File(['text'], '调查.txt'));
    expect(screen.getByRole('alert')).toHaveTextContent('请选择包含一次调查记录的 ZIP 文件');
    const oversized = new File(['zip'], '调查.zip');
    Object.defineProperty(oversized, 'size', {value: 128 * 1024 * 1024 + 1});
    selectFile(oversized);
    expect(screen.getByRole('alert')).toHaveTextContent('128 MiB 是可导入的 ZIP 文件大小上限');
    expect(props.onImport).not.toHaveBeenCalled();
  });

  it('keeps a failed import retryable with the same file and exposes the server reason', async () => {
    const onImport = vi.fn().mockRejectedValueOnce(new Error('压缩包缺少 manifest.json')).mockResolvedValueOnce(run);
    renderHistory({onImport});
    const file = new File(['zip'], '调查.zip');
    selectFile(file);
    expect(await screen.findByRole('alert')).toHaveTextContent('压缩包缺少 manifest.json');
    expect(screen.getByLabelText('选择调查 ZIP 文件')).toHaveValue('');
    selectFile(file);
    expect(await screen.findByText(/已导入“历史记录入口测试”/)).toBeInTheDocument();
    expect(onImport).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a busy state and prevents overlapping import or export', async () => {
    let finish!: (value: RunManifest) => void;
    const onImport = vi.fn().mockImplementation(() => new Promise<RunManifest>((resolve) => { finish = resolve; }));
    const props = renderHistory({onImport});
    const file = new File(['zip'], '调查.zip');
    selectFile(file);
    expect(screen.getByRole('status')).toHaveTextContent('正在导入并检查“调查.zip”');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', {name: '导入调查'})).toBeDisabled();
    expect(screen.getByRole('button', {name: /导出 .* 的调查 ZIP/})).toBeDisabled();
    selectFile(file);
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(props.onExport).not.toHaveBeenCalled();
    finish(run);
    await waitFor(() => expect(screen.getByRole('button', {name: '导入调查'})).toBeEnabled());
  });

  it.each(['created', 'paused', 'completed', 'completed_early', 'failed_recoverable'] as const)('exports a settled %s record', async (state) => {
    const settled = {...run, state};
    const props = renderHistory({runs: [settled]});
    fireEvent.click(screen.getByRole('button', {name: /导出 .* 的调查 ZIP/}));
    await waitFor(() => expect(props.onExport).toHaveBeenCalledWith(settled));
    expect(await screen.findByText(/ZIP 已准备好/)).toBeInTheDocument();
  });

  it.each(['discovering', 'collecting', 'pause_requested', 'processing'] as const)('explains why a running %s record cannot be exported', (state) => {
    const props = renderHistory({runs: [{...run, state}]});
    const button = screen.getByRole('button', {name: /导出 .* 的调查 ZIP/});
    expect(button).toBeDisabled();
    expect(screen.getByText('采集中请先暂停；分析中请等待完成后导出。')).toBeVisible();
    fireEvent.click(button);
    expect(props.onExport).not.toHaveBeenCalled();
  });

  it('restores export after an error instead of reporting a downloaded file', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('调查仍在运行，请先暂停'));
    renderHistory({onExport});
    fireEvent.click(screen.getByRole('button', {name: /导出 .* 的调查 ZIP/}));
    expect(await screen.findByRole('alert')).toHaveTextContent('调查仍在运行，请先暂停');
    expect(screen.getByRole('button', {name: /导出 .* 的调查 ZIP/})).toBeEnabled();
    expect(screen.queryByText(/ZIP 已准备好/)).not.toBeInTheDocument();
  });

  it('shows imported provenance and disables archive actions for an older backend', () => {
    renderHistory({archiveSupported: false, runs: [{...run, importedFrom: {runId: 'original', importedAt: '2026-10-11T12:00:00.000Z'}}]});
    expect(screen.getByText(/导入调查 ·/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('当前后台版本不支持调查 ZIP');
    expect(screen.getByRole('button', {name: '导入调查'})).toBeDisabled();
    expect(screen.getByRole('button', {name: /导出 .* 的调查 ZIP/})).toBeDisabled();
  });
});
