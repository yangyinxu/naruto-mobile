import {ResearchRequest, RunProgressPhase, RunState} from '../types';

const labels: Record<RunState, string> = {
  created: '准备中',
  discovering: '发现内容',
  collecting: '采集中',
  pause_requested: '正在暂停',
  paused: '已暂停',
  processing: '处理中',
  completed: '已完成',
  completed_early: '提前完成',
  failed_recoverable: '需要处理'
};

interface Props {
  state: RunState;
  phase?: RunProgressPhase;
  mode?: ResearchRequest['mode'];
}

export const StatusBadge = ({state, phase, mode}: Props) => {
  const label = state === 'processing' && phase === 'analyzing'
    ? mode === 'demo' ? '规则分析中' : 'Luna 分析中'
    : state === 'processing' && phase === 'reporting' ? '生成报告' : labels[state];
  return <span className={`status status-${state}`}>{label}</span>;
};
