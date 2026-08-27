import {Clock3, Eye, FileText, FolderOpen, PauseCircle, PlayCircle} from 'lucide-react';
import {RunManifest} from '../types';
import {StatusBadge} from './StatusBadge';

interface Props {
  runs: RunManifest[];
  onOpen: (run: RunManifest) => void;
  onBrowse: (run: RunManifest) => void;
  onOpenFolder: (run: RunManifest) => void;
}

export const History = ({runs, onOpen, onBrowse, onOpenFolder}: Props) => (
  <main className="history-page content-width">
    <div className="page-title"><div><span className="eyebrow">调查档案</span><h1>历史调查</h1><p>未完成的调查可以继续，已完成的报告随时可查看。</p></div></div>
    {runs.length === 0 ? (
      <div className="empty-state"><FileText size={42}/><h2>还没有调查记录</h2><p>新建一次 5 分钟快速调查，这里就会出现可恢复的记录。</p></div>
    ) : (
      <div className="run-list">
        {runs.map((run) => (
          <article className="run-row" key={run.id}>
            <button className="run-overview" onClick={() => onOpen(run)}>
              <div className="run-icon">{run.state === 'paused' ? <PauseCircle/> : run.reportReady ? <FileText/> : <PlayCircle/>}</div>
              <div className="run-main"><div><strong>{run.request.name}</strong><StatusBadge state={run.state}/></div><span>{run.statusMessage}</span></div>
              <div className="run-meta"><span><Clock3 size={14}/>{run.request.durationMinutes} 分钟</span><span>{new Date(run.createdAt).toLocaleString('zh-CN')}</span></div>
              <div className="run-count"><strong>{run.counts.opinions}</strong><span>条意见</span></div>
            </button>
            <div className="run-record-actions">
              <button className="browse-records" onClick={() => onBrowse(run)}><Eye size={17}/>浏览完整记录</button>
              <button aria-label={`打开 ${run.request.name} 的完整记录文件夹`} title="打开完整记录文件夹" onClick={() => onOpenFolder(run)}><FolderOpen size={17}/></button>
            </div>
          </article>
        ))}
      </div>
    )}
  </main>
);
