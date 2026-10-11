import {ChangeEvent, useRef, useState} from 'react';
import {Clock3, Download, Eye, FileText, FolderOpen, LoaderCircle, PauseCircle, PlayCircle, Upload} from 'lucide-react';
import {RunManifest} from '../types';
import {StatusBadge} from './StatusBadge';

interface Props {
  runs: RunManifest[];
  onOpen: (run: RunManifest) => void;
  onBrowse: (run: RunManifest) => void;
  onOpenFolder: (run: RunManifest) => void;
  archiveSupported?: boolean;
  onImport: (file: File) => Promise<RunManifest>;
  onExport: (run: RunManifest) => Promise<void>;
}

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const activeStates = new Set(['discovering', 'collecting', 'pause_requested', 'processing']);

export const History = ({runs, archiveSupported = true, onOpen, onBrowse, onOpenFolder, onImport, onExport}: Props) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [operation, setOperation] = useState<{kind: 'import' | 'export'; name: string; runId?: string}>();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [imported, setImported] = useState<RunManifest>();

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Clear the selection so the same file can be selected again after a failed import.
    event.currentTarget.value = '';
    if (!file || busyRef.current || !archiveSupported) return;
    setError('');
    setSuccess('');
    setImported(undefined);
    if (!/\.zip$/i.test(file.name)) {
      setError('请选择包含一次调查记录的 ZIP 文件。');
      return;
    }
    if (file.size > MAX_ARCHIVE_BYTES) {
      setError('压缩包超过 128 MiB。128 MiB 是可导入的 ZIP 文件大小上限。');
      return;
    }
    busyRef.current = true;
    setOperation({kind: 'import', name: file.name});
    try {
      const run = await onImport(file);
      setImported(run);
      setSuccess(`已导入“${run.request.name}”。原始记录、已有分析和报告已保存，可直接查看。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入失败，请重新选择调查 ZIP 文件。');
    } finally {
      busyRef.current = false;
      setOperation(undefined);
    }
  };

  const exportRun = async (run: RunManifest) => {
    if (busyRef.current || !archiveSupported || activeStates.has(run.state)) return;
    busyRef.current = true;
    setError('');
    setSuccess('');
    setImported(undefined);
    setOperation({kind: 'export', name: run.request.name, runId: run.id});
    try {
      await onExport(run);
      setSuccess(`“${run.request.name}”的 ZIP 已准备好，请在保存窗口中选择位置。保存后可把压缩包发给别人。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导出失败，请稍后重试。');
    } finally {
      busyRef.current = false;
      setOperation(undefined);
    }
  };

  return (
  <main className="history-page content-width">
    <div className="page-title history-title"><div><span className="eyebrow">调查档案</span><h1>历史调查</h1><p>未完成的调查可以继续，已完成的报告随时可查看。记录数为清理去重前的评论、回复、弹幕和作者观点合计；时长为设定的最长采集时间。</p></div>
      <button className="primary-small history-import-button" disabled={!!operation || !archiveSupported} onClick={() => fileInput.current?.click()}><Upload size={18}/>导入调查</button>
      <input ref={fileInput} className="history-file-input" type="file" accept=".zip,application/zip,application/x-zip-compressed" aria-label="选择调查 ZIP 文件" disabled={!!operation || !archiveSupported} onChange={(event) => void importFile(event)}/>
    </div>
    <div className="archive-guide"><FileText size={20} aria-hidden="true"/><div><strong>把一次调查打包分享</strong><p>点击记录旁的“导出调查”保存一个 ZIP，包含原始记录、已有分析和报告。对方在此工具的“历史调查 → 导入调查”中选择 ZIP，即可查看；导入和查看不需要登录或重新调用 AI。导入大小上限 128 MiB，指 ZIP 文件本身的大小。</p></div></div>
    {!archiveSupported && <div className="archive-notice archive-error" role="alert">当前后台版本不支持调查 ZIP。请关闭工具后重新启动更新后的 EXE，再导入或导出。</div>}
    {operation && <div className="archive-notice" role="status" aria-live="polite" aria-busy="true"><LoaderCircle size={18} className="archive-spinner" aria-hidden="true"/><span>{operation.kind === 'import' ? '正在导入并检查' : '正在打包'}“{operation.name}”，请稍候…</span></div>}
    {error && <div className="archive-notice archive-error" role="alert">{error}</div>}
    {success && <div className="archive-notice archive-success" role="status" aria-live="polite"><span>{success}</span>{imported && <button className="secondary-action" onClick={() => onOpen(imported)}>查看导入调查</button>}</div>}
    {runs.length === 0 ? (
      <div className="empty-state"><FileText size={42}/><h2>还没有调查记录</h2><p>新建一次 5 分钟快速调查，这里就会出现可恢复的记录。</p></div>
    ) : (
      <div className="run-list">
        {runs.map((run) => (
          <article className="run-row" key={run.id}>
            <button className="run-overview" onClick={() => onOpen(run)}>
              <div className="run-icon">{run.state === 'paused' ? <PauseCircle/> : run.reportReady ? <FileText/> : <PlayCircle/>}</div>
              <div className="run-main"><div><strong>{run.request.name}</strong><StatusBadge state={run.state} phase={run.progress?.phase} mode={run.request.mode}/></div><span>{run.statusMessage}</span>{run.importedFrom && <small className="imported-run-label">导入调查 · {new Date(run.importedFrom.importedAt).toLocaleString('zh-CN')}</small>}</div>
              <div className="run-meta"><span><Clock3 size={14}/>最长 {run.request.durationMinutes} 分钟</span><span>{new Date(run.createdAt).toLocaleString('zh-CN')}</span></div>
              <div className="run-count"><strong>{run.counts.opinions}</strong><span>条原始记录</span></div>
            </button>
            <div className="run-record-actions">
              <div className="run-record-buttons">
                <button className="browse-records" onClick={() => onBrowse(run)}><Eye size={17}/>浏览完整记录</button>
                <button aria-label={`打开 ${run.request.name} 的完整记录文件夹`} title="打开完整记录文件夹" onClick={() => onOpenFolder(run)}><FolderOpen size={17}/></button>
                <button className="export-run" aria-label={`导出 ${run.request.name} 的调查 ZIP`} disabled={!!operation || !archiveSupported || activeStates.has(run.state)} title={activeStates.has(run.state) ? '调查仍在运行，请先暂停采集或等待分析完成。' : '打包原始记录、已有分析和报告为 ZIP'} onClick={() => void exportRun(run)}>{operation?.kind === 'export' && operation.runId === run.id ? <LoaderCircle size={17} className="archive-spinner"/> : <Download size={17}/>}导出调查</button>
              </div>
              {activeStates.has(run.state) && <small className="archive-active-note">采集中请先暂停；分析中请等待完成后导出。</small>}
            </div>
          </article>
        ))}
      </div>
    )}
  </main>
  );
};
