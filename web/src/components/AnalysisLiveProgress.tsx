import {useEffect, useState} from 'react';
import {AiAnalysisActivity} from '../types';
import {RunStreamConnection} from '../hooks/useRunStream';

interface Props {
  activity: AiAnalysisActivity;
  working: boolean;
  connection: RunStreamConnection;
  updatedAt: string;
}

const secondsSince = (timestamp: string | undefined, now: number) => timestamp
  ? Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000)) || 0 : 0;
const elapsedTime = (seconds: number) => `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;

export const AnalysisLiveProgress = ({activity, working, connection, updatedAt}: Props) => {
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
  const stageLabel = activity.stage === 'triage' ? 'Decisions 初筛'
    : activity.stage === 'detail' ? 'Luna 详析' : '准备分析';

  return (
    <section className="analysis-live" aria-label="实时分析进度">
      <div className="analysis-live-heading"><strong>{stageLabel}</strong><span>分析已用时 <b>{elapsedTime(secondsSince(activity.startedAt, observedTime))}</b></span></div>
      <div className="analysis-live-counts">
        <span>已初筛 <b>{activity.screened}/{activity.screeningTotal}</b></span>
        <span>已详析 <b>{activity.detailed}/{activity.stage === 'detail' ? activity.detailTotal : '待初筛完成'}</b></span>
        {live && <span>正在处理 <b>{activity.inFlightOpinions} 条</b> · {activity.inFlightRequests} 批</span>}
      </div>
      <div className="analysis-live-wait">
        {working && connection !== 'connected'
          ? <span role="status">进度连接已断开，正在重连；当前显示最后保存的进度。</span>
          : !working ? <span>分析已暂停，进度已保存。</span>
            : <>
              {activity.oldestRequestStartedAt && <span>本轮响应已等待 <b>{secondsSince(activity.oldestRequestStartedAt, observedTime)} 秒</b></span>}
              {activity.retryingRequests > 0 && <span role="status">{activity.retryingRequests} 批等待重试 · {retrySeconds > 0 ? `${retrySeconds} 秒后重试` : '正在重新发起请求'}</span>}
              {activity.lastResultAt && <span>上次收到结果距今 {secondsSince(activity.lastResultAt, observedTime)} 秒</span>}
              {!activity.inFlightRequests && !activity.retryingRequests && <span>正在整理已返回的结果…</span>}
            </>}
      </div>
    </section>
  );
};
