import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
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
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
  render(<History {...props}/>);
  return props;
};

const selectFile = (file?: File) => fireEvent.change(screen.getByLabelText('选择调查 ZIP 文件'), {
  target: {files: file ? [file] : []}
});

afterEach(() => vi.restoreAllMocks());

describe('History', () => {
  it('offers portable ZIP backup for browser data without an unavailable OS folder action', () => {
    renderHistory({browserRuntime: true});
    expect(screen.getByRole('button', {name: /导出.*调查 ZIP/})).toBeVisible();
    expect(screen.getByRole('button', {name: '浏览完整记录'})).toBeVisible();
    expect(screen.getByRole('button', {name: /删除 .* 的调查/})).toBeVisible();
    expect(screen.queryByRole('button', {name: /打开.*完整记录文件夹/})).not.toBeInTheDocument();
  });
  it('offers complete record browsing and folder opening for every run', () => {
    const onBrowse = vi.fn();
    const onOpenFolder = vi.fn();
    renderHistory({onBrowse, onOpenFolder});
    expect(screen.queryByRole('button', {name: /删除 .* 的调查/})).not.toBeInTheDocument();
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

  it('keeps the record when deletion confirmation is cancelled', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const props = renderHistory({browserRuntime: true});
    fireEvent.click(screen.getByRole('button', {name: /删除 .* 的调查/}));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('无法撤销'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('先导出调查 ZIP 备份'));
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(run.request.name)).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['paused', 'completed', 'completed_early', 'failed_recoverable'] as const)('deletes a confirmed settled %s record', async (state) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const settled = {...run, state};
    const props = renderHistory({browserRuntime: true, runs: [settled]});
    fireEvent.click(screen.getByRole('button', {name: /删除 .* 的调查/}));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith(settled));
    expect(await screen.findByRole('status')).toHaveTextContent(`已删除“${run.request.name}”`);
  });

  it.each(['created', 'discovering', 'collecting', 'pause_requested', 'processing'] as const)('blocks deletion of a running %s record', (state) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const props = renderHistory({browserRuntime: true, runs: [{...run, state}]});
    const button = screen.getByRole('button', {name: /删除 .* 的调查/});
    expect(button).toBeDisabled();
    expect(screen.getByText('调查运行中请先暂停采集，或等待分析完成后导出、删除。')).toBeVisible();
    fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('prevents deletion while an import is pending', async () => {
    let finish!: (value: RunManifest) => void;
    const onImport = vi.fn().mockImplementation(() => new Promise<RunManifest>(resolve => {finish = resolve;}));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const props = renderHistory({browserRuntime: true, onImport});
    selectFile(new File(['zip'], '调查.zip'));
    const button = screen.getByRole('button', {name: /删除 .* 的调查/});
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
    finish(run);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('prevents deletion while an export is pending', async () => {
    let finish!: () => void;
    const onExport = vi.fn().mockImplementation(() => new Promise<void>(resolve => {finish = resolve;}));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const props = renderHistory({browserRuntime: true, onExport});
    fireEvent.click(screen.getByRole('button', {name: /导出 .* 的调查 ZIP/}));
    const button = screen.getByRole('button', {name: /删除 .* 的调查/});
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('prevents import, export, and another deletion until the pending deletion succeeds', async () => {
    let finish!: () => void;
    const onDelete = vi.fn().mockImplementation(() => new Promise<void>(resolve => {finish = resolve;}));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const otherRun = {...run, id: 'second-run', request: {...run.request, name: '另一份调查'}};
    const props = renderHistory({browserRuntime: true, runs: [run, otherRun], onDelete});
    const button = screen.getByRole('button', {name: `删除 ${run.request.name} 的调查`});
    fireEvent.click(button);
    expect(screen.getByRole('status')).toHaveTextContent(`正在删除“${run.request.name}”`);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/已删除/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: '导入调查'})).toBeDisabled();
    expect(screen.getByLabelText('选择调查 ZIP 文件')).toBeDisabled();
    for (const exportButton of screen.getAllByRole('button', {name: /导出 .* 的调查 ZIP/})) {
      expect(exportButton).toBeDisabled();
      fireEvent.click(exportButton);
    }
    for (const deleteButton of screen.getAllByRole('button', {name: /删除 .* 的调查/})) {
      expect(deleteButton).toBeDisabled();
      fireEvent.click(deleteButton);
    }
    selectFile(new File(['zip'], '调查.zip'));
    expect(props.onImport).not.toHaveBeenCalled();
    expect(props.onExport).not.toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    finish();
    expect(await screen.findByText(/已删除“历史记录入口测试”/)).toBeVisible();
    expect(button).toBeEnabled();
    expect(screen.getByRole('button', {name: '导入调查'})).toBeEnabled();
    expect(screen.getByRole('button', {name: `导出 ${run.request.name} 的调查 ZIP`})).toBeEnabled();
  });

  it('keeps failed deletion retryable and reports success only after a successful retry', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onDelete = vi.fn().mockRejectedValueOnce(new Error('删除失败：存储事务未提交')).mockResolvedValueOnce(undefined);
    renderHistory({browserRuntime: true, onDelete});
    const button = screen.getByRole('button', {name: /删除 .* 的调查/});
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败：存储事务未提交');
    expect(button).toBeEnabled();
    expect(screen.getByText(run.request.name)).toBeVisible();
    expect(screen.queryByText(/已删除/)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText(/已删除“历史记录入口测试”/)).toBeVisible();
    expect(onDelete).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
