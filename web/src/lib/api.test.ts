import {afterEach, describe, expect, it, vi} from 'vitest';
import {api} from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('survey archives API', () => {
  it('uploads the ZIP bytes without JSON wrapping or requiring an analysis login', async () => {
    const run = {id: 'imported'};
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({run, originalRunId: 'original'}), {status: 201}));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['zip bytes'], '调查.zip', {type: 'application/zip'});
    await expect(api.importRun(file)).resolves.toEqual(run);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/runs/import', {
      method: 'POST', headers: {'Content-Type': 'application/zip'}, body: file
    });
  });

  it('uses archive validation errors and handles a non-JSON upload failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({message: '不支持的压缩包格式'}), {status: 400}))
      .mockResolvedValueOnce(new Response('<html>server failure</html>', {status: 500}));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['zip'], '调查.zip');
    await expect(api.importRun(file)).rejects.toThrow('不支持的压缩包格式');
    await expect(api.importRun(file)).rejects.toThrow('导入失败，请选择本工具导出的调查 ZIP 文件');
  });

  it('downloads a ZIP with its UTF-8 filename and releases the blob after download handoff', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue('blob:archive');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {createObjectURL, revokeObjectURL});
    const filename = '十月份活动-调查.zip';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('zip bytes', {
      headers: {'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="archive.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`}
    })));
    let anchor: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { anchor = this; });
    await api.exportRun('run-id');
    expect(anchor?.download).toBe(filename);
    expect(anchor?.href).toBe('blob:archive');
    expect(document.querySelector('a[download]')).not.toBeInTheDocument();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:archive');
  });

  it('falls back from an invalid UTF-8 filename and removes unsafe filename characters', async () => {
    vi.stubGlobal('URL', {createObjectURL: vi.fn().mockReturnValue('blob:archive'), revokeObjectURL: vi.fn()});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('zip', {
      headers: {'Content-Disposition': 'attachment; filename="archive/survey.zip"; filename*=UTF-8\'\'%invalid'}
    })));
    let filename = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    await api.exportRun('run-id');
    expect(filename).toBe('archive-survey.zip');
  });

  it('does not start a download for JSON, non-JSON or empty archive failures', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({message: '请等待分析完成'}), {status: 409}))
      .mockResolvedValueOnce(new Response('<html>failure</html>', {status: 500}))
      .mockResolvedValueOnce(new Response('')));
    await expect(api.exportRun('run-id')).rejects.toThrow('请等待分析完成');
    await expect(api.exportRun('run-id')).rejects.toThrow('导出失败，请稍后重试');
    await expect(api.exportRun('run-id')).rejects.toThrow('导出的压缩包为空');
    expect(click).not.toHaveBeenCalled();
  });
});
