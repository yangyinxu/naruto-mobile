import {useEffect, useMemo, useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Clock3,
  FileText,
  FolderOpen,
  Download,
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
import {AnalysisLiveProgress} from './AnalysisLiveProgress';

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
  if (run.stopReason && !['analyzing', 'reporting'].includes(run.progress?.phase ?? '')) return 'analyzing';
  if (run.state === 'paused' && !run.stopReason && !['analyzing', 'reporting'].includes(run.progress?.phase ?? '')) return 'collecting';
  if (run.progress) return run.progress.phase;
  if (run.stopReason) return 'analyzing';
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
  const [run, setRun, connection = 'connected'] = useRunStream(initial.id, initial);
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
  const canResume = ['paused', 'failed_recoverable'].includes(run.state);
  const resumeAnalysis = canResume && collectionFinished && !run.reportReady;
  const displayTimeMs = collectionFinished ? run.activeElapsedMs : remainingMs;
  const progress = getRunProgressPercent(run);
  const remainingMinutes = Math.floor(displayTimeMs / 60_000);
  const remainingSeconds = Math.floor((displayTimeMs % 60_000) / 1000);
  const isCurrentStageWorking = workingStates.has(run.state) && connection === 'connected';
  const analysisProgress = run.progress?.phase === 'analyzing' ? run.progress : legacyAnalysisProgress(run.statusMessage);
  const analysisStatus = runPhase === 'analyzing' && analysisProgress?.total !== undefined && analysisProgress.completed !== undefined
    ? `分析总处理：${analysisProgress.completed}/${analysisProgress.total} 条记录已有最终分类（含缓存与排除项）`
    : run.statusMessage;
  const finalAnalysis = run.reportReady ? run.analysis : undefined;
  const classifiedViewers = finalAnalysis ? finalAnalysis.strongOpinions + finalAnalysis.weakOpinions + finalAnalysis.noiseOpinions : undefined;
  const rawBreakdownKnown = finalAnalysis && [finalAnalysis.processedOpinions, finalAnalysis.duplicateOpinions,
    finalAnalysis.cleaningExcludedOpinions, finalAnalysis.missingContentOpinions].every((value) => typeof value === 'number');
  const finalRoutesKnown = finalAnalysis?.mode === 'ai' && [finalAnalysis.processedOpinions, finalAnalysis.creatorViewsExcluded,
    finalAnalysis.localHardNoise, finalAnalysis.fastTriageSkipped, finalAnalysis.detailedAiOpinions].every((value) => typeof value === 'number');
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

  const errorMessage = run.error === 'The analysis service is temporarily unavailable.'
    ? 'Luna 分析服务暂时不可用。已保存原始数据和分析缓存，请稍后点击“继续分析并生成报告”。'
    : resumeAnalysis && ['Failed to fetch', 'fetch failed'].includes(run.error ?? '')
      ? 'Luna 分析时网络连接中断。已保存原始数据和分析缓存，请检查网络后点击“继续分析并生成报告”。'
    : run.error;

  return (
    <main className="run-page content-width">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17}/> 返回历史调查</button>
      <section className="run-header">
        <div><div className="eyebrow"><Radio size={14}/> {run.request.mode === 'demo' ? '本地规则演示' : `Luna AI 调查${run.analysis?.model ? ` · ${run.analysis.model}` : ''}`}</div><h1>{run.request.name}</h1><p className="run-status" aria-live="polite"><span>{analysisStatus}</span>{isCurrentStageWorking && <span className="stage-activity" aria-label="当前步骤仍在进行中"><i/><i/><i/></span>}</p></div>
        <StatusBadge state={run.state} phase={runPhase} mode={run.request.mode}/>
      </section>

      {errorMessage && <div className="error-banner"><AlertTriangle size={20}/><div><strong>{resumeAnalysis ? 'Luna 分析中断' : '调查遇到问题'}</strong><span>{errorMessage}</span></div></div>}

      <section className="progress-panel">
        <div className="time-display"><span>{collectionFinished ? '实际采集用时' : '剩余采集时间'}</span><strong>{String(remainingMinutes).padStart(2, '0')}<small>:</small>{String(remainingSeconds).padStart(2, '0')}</strong><em>{collectionFinished ? `${run.request.mode === 'live' ? 'Luna 分析' : '本地分析'}和报告生成不计入` : '暂停期间不计时'}</em></div>
        <div className="progress-area">
          <div className="progress-copy"><span>调查总进度</span><strong>{Math.round(progress)}%</strong></div>
          <div className="progress-track" role="progressbar" aria-label="调查总进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{width: `${progress}%`}}/></div>
          <p className="progress-scope">四个阶段各占 25%：发现来源、采集、分析、报告。采集按已用时 / 设定时长推进；分析按已有最终分类 / 本次分析记录推进；报告完成才到 100%。这是流程进度，不能用来估计剩余时间。</p>
          <div className="progress-stages">
            <div className="progress-stage-line" aria-hidden="true"><i style={{width: `${stageLineProgress}%`}}/></div>
            <span className={`progress-stage ${stageClass('discovering')}`}><Search/>发现热点</span>
            <span className={`progress-stage ${stageClass('collecting')}`}><MessageSquareText/>收集意见</span>
            <span className={`progress-stage ${stageClass('analyzing')}`}><Sparkles/>{run.request.mode === 'live' ? 'Luna 分析' : '规则分析'}</span>
            <span className={`progress-stage ${stageClass('reporting')}`}><FileText/>生成报告</span>
          </div>
        </div>
      </section>

      {runPhase === 'analyzing' && run.progress?.activity && <AnalysisLiveProgress
        activity={run.progress.activity} working={run.state === 'processing'}
        connection={connection} updatedAt={run.updatedAt}
        overallCompleted={analysisProgress?.completed} overallTotal={analysisProgress?.total}
      />}

      {runPhase === 'analyzing' && !run.progress?.activity && <p className="count-scope-note">分析总处理统计已得到最终分类的记录，包含缓存、排除项和详析完成项；分母是清理去重后具有来源的记录。旧版进度没有保存初筛、详析与缓存分项，无法可靠还原。</p>}

      <section className="metric-grid">
        <div className="metric-card"><Video/><span>已保存来源</span><strong>{run.counts.sources}</strong><small>发现 {run.counts.candidates} 个候选；上方为成功保存的独立视频或专栏页面，采集失败的候选不计入。</small></div>
        <div className="metric-card"><MessageSquareText/><span>原始采集记录</span><strong>{run.counts.opinions}</strong><small>评论、回复、弹幕和作者观点合计；清理去重前的记录数，不是玩家人数。</small></div>
        <div className="metric-card"><FileText/><span>{run.request.mode === 'demo' ? '演示采用意见' : '报告采用的观众意见'}</span><strong>{run.reportReady ? run.counts.validOpinions : '—'}</strong><small>{run.reportReady && run.analysis ? `强洞察 ${run.analysis.strongOpinions} · 弱信号 ${run.analysis.weakOpinions} · 无参考价值 ${run.analysis.noiseOpinions}；需要复核的强洞察不自动进入报告。` : '完成分析并生成报告后显示；不会把全部详析记录当作有效意见。'}</small></div>
        <div className={`metric-card ${run.counts.warnings ? 'warning' : ''}`}><AlertTriangle/><span>采集提醒次数</span><strong>{run.counts.warnings}</strong><small>页面采集失败、未加载出评论等提醒的发生次数，不代表丢失记录数。</small></div>
      </section>

      {finalAnalysis && <section className="analysis-count-summary" aria-label="完成分析数量口径">
        <h2>完成后的数量如何对应</h2>
        <p className="analysis-count-equation">已分类观众记录 {classifiedViewers} = 强洞察 {finalAnalysis.strongOpinions} + 弱信号 {finalAnalysis.weakOpinions} + 无参考价值 {finalAnalysis.noiseOpinions}。</p>
        <p>这些是清理去重后的观众记录，作者观点另列。强洞察信息充分、有产品参考价值；弱信号保留但不进入结论；无参考价值被排除。报告采用 {run.counts.validOpinions} 条，采用数量可能少于强洞察，因为需要复核的结果不会自动入选。</p>
        {rawBreakdownKnown ? <p className="analysis-count-equation">原始记录 {run.counts.opinions} = 清理去重后的已分类记录 {finalAnalysis.processedOpinions} + 重复记录 {finalAnalysis.duplicateOpinions} + 其他清理排除 {finalAnalysis.cleaningExcludedOpinions} + 缺少来源的记录 {finalAnalysis.missingContentOpinions}。</p>
          : <p>这份旧版调查未保存完整的清理数量，无法从原始记录数可靠推算去重后的分析总数。</p>}
        {finalRoutesKnown && <p className="analysis-count-equation">已分类记录 {finalAnalysis.processedOpinions} = 作者观点排除 {finalAnalysis.creatorViewsExcluded} + 本地无信息排除 {finalAnalysis.localHardNoise} + Decisions 跳过 {finalAnalysis.fastTriageSkipped} + Luna 详析 {finalAnalysis.detailedAiOpinions}。</p>}
        {finalAnalysis.cachedAiOpinions !== undefined && <p>本次复用缓存 {finalAnalysis.cachedAiOpinions} 条。完成后的分流数量包含缓存记录原先的处理路径，因此缓存是其中的子集，不能再加到已分类总数上。</p>}
      </section>}

      <section className="control-panel">
        <div className="control-copy"><h2>{run.reportReady ? '报告已经准备好' : resumeAnalysis ? '可以继续完成分析' : run.state === 'paused' ? '调查已安全暂停' : '你可以随时控制调查'}</h2><p>{run.reportReady ? import.meta.env.MODE === 'hosted' ? '查看报告并导出 HTML 或 Markdown，也可导出调查 ZIP 备份完整记录。' : '查看报告并导出 HTML，浏览器可离线打开；也可导出 Markdown 或打开本地数据目录。' : resumeAnalysis ? '继续使用已收集的意见，复用已保存的分析结果，完成后生成报告。' : '暂停会先完成当前页面并保存检查点；提前生成不会丢掉已有样本。'}</p></div>
        <div className="control-actions">
          {activeStates.has(run.state) && run.state !== 'pause_requested' && <button className="secondary-action" disabled={busy} onClick={() => void action(() => api.pause(run.id))}><Pause size={17}/>暂停</button>}
          {canResume && !run.reportReady && <button className="primary-small" disabled={busy || (!resumeAnalysis && remainingMs <= 0)} onClick={() => void action(() => api.resume(run.id))}><Play size={17}/>{resumeAnalysis ? '继续分析并生成报告' : '继续采集'}</button>}
          {canResume && !collectionFinished && <button className="secondary-action" disabled={busy} onClick={() => void action(() => api.extend(run.id, 5))}><Plus size={17}/>增加 5 分钟</button>}
          {!run.reportReady && run.state !== 'processing' && !resumeAnalysis && <button className="danger-action" disabled={busy || run.state === 'pause_requested'} onClick={finalize}><Square size={16}/>终止并生成</button>}
          {run.reportReady && <button className="primary-small" onClick={() => onReport(run)}><FileText size={17}/>查看调查报告</button>}
          {run.reportReady && run.request.mode === 'live' && <button className="secondary-action" disabled={busy} onClick={() => void action(() => api.reanalyze(run.id))}><RefreshCw size={17}/>重新用 Luna 分析</button>}
          {import.meta.env.MODE === 'hosted'
            ? <button className="secondary-action" disabled={activeStates.has(run.state)} onClick={() => void api.exportRun(run.id).catch((error) => onError(error.message))}><Download size={17}/>导出调查 ZIP</button>
            : <button className="secondary-action" onClick={() => void api.openFolder(run.id).catch((error) => onError(error.message))}><FolderOpen size={17}/>打开数据文件夹</button>}
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
