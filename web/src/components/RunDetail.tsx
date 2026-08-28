import {useEffect, useMemo, useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Clock3,
  FileText,
  FolderOpen,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Video
} from 'lucide-react';
import {api} from '../lib/api';
import {useRunStream} from '../hooks/useRunStream';
import {RunEvent, RunManifest, RunProgressPhase} from '../types';
import {StatusBadge} from './StatusBadge';

interface Props {
  initial: RunManifest;
  onBack: () => void;
  onReport: (run: RunManifest) => void;
  onError: (message: string) => void;
}

const activeStates = new Set(['created', 'discovering', 'collecting', 'pause_requested']);
const workingStates = new Set(['created', 'discovering', 'collecting', 'pause_requested', 'processing']);
const phaseRank: Record<RunProgressPhase, number> = {
  preparing: 0,
  discovering: 1,
  collecting: 2,
  analyzing: 3,
  reporting: 4,
  completed: 5
};

const legacyAnalysisProgress = (statusMessage: string) => {
  const match = statusMessage.match(/(\d+)\/(\d+)/);
  if (!match) return undefined;
  return {completed: Number(match[1]), total: Number(match[2])};
};

export const getRunPhase = (run: RunManifest): RunProgressPhase => {
  if (run.reportReady || run.state === 'completed' || run.state === 'completed_early') return 'completed';
  if (run.state === 'paused') return 'collecting';
  if (run.progress) return run.progress.phase;
  if (run.state === 'processing') return 'analyzing';
  if (run.state === 'discovering') return 'discovering';
  if (['collecting', 'pause_requested', 'paused', 'failed_recoverable'].includes(run.state)) return 'collecting';
  return 'preparing';
};

export const getRunProgressPercent = (run: RunManifest) => {
  const phase = getRunPhase(run);
  const collectionBudgetMs = run.request.durationMinutes * 60_000;
  const collectionRatio = collectionBudgetMs > 0 ? Math.min(1, run.activeElapsedMs / collectionBudgetMs) : 0;
  const analysis = run.progress?.phase === 'analyzing' ? run.progress : legacyAnalysisProgress(run.statusMessage);
  const analysisRatio = analysis?.total ? Math.min(1, (analysis.completed ?? 0) / analysis.total) : 0;

  // Each visible workflow stage contributes one quarter; measurable stages advance within their quarter.
  switch (phase) {
    case 'preparing': return 0;
    case 'discovering': return 0;
    case 'collecting': return 25 + collectionRatio * 25;
    case 'analyzing': return 50 + analysisRatio * 25;
    case 'reporting': return 75;
    case 'completed': return 100;
  }
};

export const RunDetail = ({initial, onBack, onReport, onError}: Props) => {
  const [run, setRun] = useRunStream(initial.id, initial);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = () => api.runDetail(initial.id).then((detail) => setEvents(detail.events)).catch(() => undefined);
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [initial.id]);

  const remainingMs = useMemo(() => run
    ? Math.max(0, run.request.durationMinutes * 60_000 - run.activeElapsedMs)
    : 0, [run]);
  if (!run) return null;
  const runPhase = getRunPhase(run);
  const currentPhaseRank = phaseRank[runPhase];
  const collectionFinished = currentPhaseRank >= phaseRank.analyzing;
  const displayTimeMs = collectionFinished ? run.activeElapsedMs : remainingMs;
  const progress = getRunProgressPercent(run);
  const remainingMinutes = Math.floor(displayTimeMs / 60_000);
  const remainingSeconds = Math.floor((displayTimeMs % 60_000) / 1000);
  const isCurrentStageWorking = workingStates.has(run.state);
  const stageLineProgress = Math.min(100, Math.max(0, (currentPhaseRank - phaseRank.discovering) / 3 * 100));
  const stageClass = (phase: RunProgressPhase) => currentPhaseRank > phaseRank[phase]
    ? 'done'
    : currentPhaseRank === phaseRank[phase] ? 'active' : '';

  const action = async (operation: () => Promise<RunManifest>) => {
    setBusy(true);
    try {
      setRun(await operation());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const finalize = () => {
    if (!window.confirm('将停止继续采集，并使用目前已有数据生成报告。确定继续吗？')) return;
    void action(() => api.finalize(run.id));
  };

  return (
    <main className="run-page content-width">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17}/> 返回历史调查</button>
      <section className="run-header">
        <div><div className="eyebrow"><Radio size={14}/> {run.request.mode === 'demo' ? '本地规则演示' : `Luna AI 调查${run.analysis?.model ? ` · ${run.analysis.model}` : ''}`}</div><h1>{run.request.name}</h1><p className="run-status" aria-live="polite"><span>{run.statusMessage}</span>{isCurrentStageWorking && <span className="stage-activity" aria-label="当前步骤仍在进行中"><i/><i/><i/></span>}</p></div>
        <StatusBadge state={run.state} phase={runPhase} mode={run.request.mode}/>
      </section>

      {run.error && <div className="error-banner"><AlertTriangle size={20}/><div><strong>调查遇到问题</strong><span>{run.error}</span></div></div>}

      <section className="progress-panel">
        <div className="time-display"><span>{collectionFinished ? '实际采集用时' : '剩余采集时间'}</span><strong>{String(remainingMinutes).padStart(2, '0')}<small>:</small>{String(remainingSeconds).padStart(2, '0')}</strong><em>{collectionFinished ? `${run.request.mode === 'live' ? 'Luna 分析' : '本地分析'}和报告生成不计入` : '暂停期间不计时'}</em></div>
        <div className="progress-area">
          <div className="progress-copy"><span>调查总进度</span><strong>{Math.round(progress)}%</strong></div>
          <div className="progress-track" role="progressbar" aria-label="调查总进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{width: `${progress}%`}}/></div>
          <div className="progress-stages">
            <div className="progress-stage-line" aria-hidden="true"><i style={{width: `${stageLineProgress}%`}}/></div>
            <span className={`progress-stage ${stageClass('discovering')}`}><Search/>发现热点</span>
            <span className={`progress-stage ${stageClass('collecting')}`}><MessageSquareText/>收集意见</span>
            <span className={`progress-stage ${stageClass('analyzing')}`}><Sparkles/>{run.request.mode === 'live' ? 'Luna 分析' : '规则分析'}</span>
            <span className={`progress-stage ${stageClass('reporting')}`}><FileText/>生成报告</span>
          </div>
        </div>
      </section>

      <section className="metric-grid">
        <div className="metric-card"><Video/><span>已处理来源</span><strong>{run.counts.sources}</strong><small>发现 {run.counts.candidates} 个候选</small></div>
        <div className="metric-card"><MessageSquareText/><span>已收集意见</span><strong>{run.counts.opinions}</strong><small>标题与观众意见分开</small></div>
        <div className="metric-card"><FileText/><span>{run.request.mode === 'demo' ? '演示有效意见' : 'AI 强洞察'}</span><strong>{run.reportReady ? run.counts.validOpinions : '—'}</strong><small>{run.analysis ? `弱信号 ${run.analysis.weakOpinions} · 无价值 ${run.analysis.noiseOpinions}${run.analysis.detailedAiOpinions !== undefined ? ` · 详析 ${run.analysis.detailedAiOpinions}` : ''}` : '报告生成后显示'}</small></div>
        <div className={`metric-card ${run.counts.warnings ? 'warning' : ''}`}><AlertTriangle/><span>采集提醒</span><strong>{run.counts.warnings}</strong><small>不会丢失已保存数据</small></div>
      </section>

      <section className="control-panel">
        <div className="control-copy"><h2>{run.reportReady ? '报告已经准备好' : run.state === 'paused' ? '调查已安全暂停' : '你可以随时控制调查'}</h2><p>{run.reportReady ? '查看网页报告，或打开本地目录获取 Markdown 和 JSONL 文件。' : '暂停会先完成当前页面并保存检查点；提前生成不会丢掉已有样本。'}</p></div>
        <div className="control-actions">
          {activeStates.has(run.state) && run.state !== 'pause_requested' && <button className="secondary-action" disabled={busy} onClick={() => void action(() => api.pause(run.id))}><Pause size={17}/>暂停</button>}
          {['paused', 'failed_recoverable'].includes(run.state) && <button className="primary-small" disabled={busy || remainingMs <= 0} onClick={() => void action(() => api.resume(run.id))}><Play size={17}/>继续采集</button>}
          {['paused', 'failed_recoverable'].includes(run.state) && <button className="secondary-action" disabled={busy} onClick={() => void action(() => api.extend(run.id, 5))}><Plus size={17}/>增加 5 分钟</button>}
          {!run.reportReady && run.state !== 'processing' && <button className="danger-action" disabled={busy || run.state === 'pause_requested'} onClick={finalize}><Square size={16}/>终止并生成</button>}
          {run.reportReady && <button className="primary-small" onClick={() => onReport(run)}><FileText size={17}/>查看调查报告</button>}
          {run.reportReady && run.request.mode === 'live' && <button className="secondary-action" disabled={busy} onClick={() => void action(() => api.reanalyze(run.id))}><RefreshCw size={17}/>重新用 Luna 分析</button>}
          <button className="secondary-action" onClick={() => void api.openFolder(run.id).catch((error) => onError(error.message))}><FolderOpen size={17}/>打开数据文件夹</button>
        </div>
      </section>

      <section className="activity-panel">
        <div className="section-title"><div><h2>活动记录</h2><p>每一步都会写入本地事件日志</p></div><Clock3 size={20}/></div>
        <div className="event-list">
          {events.length === 0 && <p className="muted">正在等待第一条记录…</p>}
          {[...events].reverse().slice(0, 12).map((event, index) => (
            <div className={`event event-${event.level}`} key={`${event.timestamp}-${index}`}><i/><time>{new Date(event.timestamp).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit'})}</time><span>{event.message}</span></div>
          ))}
        </div>
      </section>
    </main>
  );
};
