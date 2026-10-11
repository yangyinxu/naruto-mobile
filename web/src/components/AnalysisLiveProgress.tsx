import {useEffect, useState} from 'react';
import {AiAnalysisActivity} from '../types';
import {RunStreamConnection} from '../hooks/useRunStream';

interface Props {
  activity: AiAnalysisActivity;
  working: boolean;
  connection: RunStreamConnection;
  updatedAt: string;
  overallCompleted?: number;
  overallTotal?: number;
}

const secondsSince = (timestamp: string | undefined, now: number) => timestamp
  ? Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000)) || 0 : 0;
const elapsedTime = (seconds: number) => `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;

export const AnalysisLiveProgress = ({activity, working, connection, updatedAt, overallCompleted, overallTotal}: Props) => {
  const [now, setNow] = useState(Date.now);
  const live = working && connection === 'connected';
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const observedTime = live ? now : Date.parse(updatedAt);
  const retrySeconds = activity.nextRetryAt
    ? Math.max(0, Math.ceil((Date.parse(activity.nextRetryAt) - observedTime) / 1000)) : 0;
  const screeningComplete = activity.stage !== 'preparing' && activity.screened === activity.screeningTotal;
  const stageLabel = !screeningComplete && activity.detailTotal > 0 ? 'Decisions 初筛与 Luna 详析同时进行'
    : activity.stage === 'triage' ? 'Decisions 初筛'
    : activity.stage === 'detail' ? 'Luna 详析' : '准备分析';
  const hasBreakdown = [activity.cached, activity.localExcluded, activity.triageSkipped]
    .every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0);
  const unscreened = Math.max(0, activity.screeningTotal - activity.screened);
  const detailRemaining = Math.max(0, activity.detailTotal - activity.detailed);
  const routedTotal = hasBreakdown ? activity.cached! + activity.localExcluded! + activity.triageSkipped! + activity.detailTotal + unscreened : undefined;
  const routedCompleted = hasBreakdown ? activity.cached! + activity.localExcluded! + activity.triageSkipped! + activity.detailed : undefined;
  const displayTotal = overallTotal ?? routedTotal;
  const displayCompleted = overallCompleted ?? routedCompleted;
  const balancedBreakdown = hasBreakdown && activity.stage !== 'preparing'
    && routedTotal === displayTotal && routedCompleted === displayCompleted;

  return (
    <section className="analysis-live" aria-label="实时分析进度">
      <div className="analysis-live-heading"><strong>{stageLabel}</strong><span>分析已用时 <b>{elapsedTime(secondsSince(activity.startedAt, observedTime))}</b></span></div>
      <div className="analysis-live-counts">
        {displayTotal !== undefined && displayCompleted !== undefined && <span>分析总处理 <b>{displayCompleted}/{displayTotal}</b><small>已得到最终分类 / 进入分析的记录数</small></span>}
        <span>Decisions 已初筛 <b>{activity.screened}/{activity.screeningTotal}</b><small>已返回初筛结果 / 本次送入初筛</small></span>
        <span>Luna 已详析 <b>{activity.detailed}/{activity.detailTotal}</b><small>{screeningComplete ? '已返回详析结果 / 全部需要详析' : '已返回详析结果 / 当前已进入详析；总量待初筛结束确定'}</small></span>
        {activity.effectiveConcurrency !== undefined && activity.configuredConcurrency !== undefined && <span>AI 并行请求上限 <b>{activity.effectiveConcurrency}/{activity.configuredConcurrency}</b><small>当前采用上限 / 配置上限；与 Chrome 采集标签页数分别设置</small></span>}
        {live && <span>正在请求 <b>{activity.inFlightOpinions} 条</b> · <b>{activity.inFlightRequests} 批</b><small>初筛与详析合计；条是记录数，批是 API 请求数</small></span>}
      </div>
      <div className="analysis-count-explanation" aria-label="分析数量口径">
        <p>分析总处理包含复用缓存、本地排除、Decisions 跳过和 Luna 详析完成；它表示记录已有最终分类，不代表都经过 Luna。分母是清理去重后、具有来源的记录，包含单独排除的作者观点。</p>
        {balancedBreakdown ? <>
          <p className="analysis-count-equation">全部记录 {displayTotal} = 复用缓存 {activity.cached} + 本地排除 {activity.localExcluded} + Decisions 跳过 {activity.triageSkipped} + {screeningComplete ? '需要详析' : '当前进入详析'} {activity.detailTotal}{!screeningComplete && <> + 尚待初筛 {unscreened}</>}</p>
          <p className="analysis-count-equation">已完成 {displayCompleted} = 复用缓存 {activity.cached} + 本地排除 {activity.localExcluded} + Decisions 跳过 {activity.triageSkipped} + 详析完成 {activity.detailed}；待完成 {displayTotal! - displayCompleted!} = 详析待完成 {detailRemaining}{!screeningComplete && <> + 尚待初筛 {unscreened}</>}</p>
          <p>以上分项在本次分析中互不重叠。复用缓存可能来自先前的本地排除、初筛或详析，本次统一计入缓存，不再重复计入其他分项。{activity.creatorExcluded !== undefined && activity.noiseExcluded !== undefined && <> 本地排除 {activity.localExcluded} = 作者观点 {activity.creatorExcluded} + 明确无信息记录 {activity.noiseExcluded}。</>}</p>
        </> : activity.stage === 'preparing' && hasBreakdown ? <p>正在确定本地排除、初筛与详析的分流数量。</p>
          : <p>当前记录未保存完整的分流数量，缓存、本地排除和初筛跳过的分项无法可靠还原；初筛与详析数量分别显示，不相加作为总处理数。</p>}
      </div>
      <div className="analysis-live-wait">
        {working && connection !== 'connected'
          ? <span role="status">进度连接已断开，正在重连；当前显示最后保存的进度。</span>
          : !working ? <span>分析已暂停，进度已保存。</span>
            : <>
              {activity.oldestRequestStartedAt && <span>本轮响应已等待 <b>{secondsSince(activity.oldestRequestStartedAt, observedTime)} 秒</b></span>}
              {activity.retryingRequests > 0 && <span role="status">{activity.retryingRequests} 批 API 请求等待重试 · {retrySeconds > 0 ? `${retrySeconds} 秒后重试` : '正在重新发起请求'}</span>}
              {activity.lastResultAt && <span>上次收到结果距今 {secondsSince(activity.lastResultAt, observedTime)} 秒</span>}
              {!activity.inFlightRequests && !activity.retryingRequests && <span>正在整理已返回的结果…</span>}
            </>}
      </div>
    </section>
  );
};
