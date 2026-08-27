import {RunState} from '../types';

const labels: Record<RunState, string> = {
  created: '准备中',
  discovering: '发现内容',
  collecting: '采集中',
  pause_requested: '正在暂停',
  paused: '已暂停',
  processing: '生成报告',
  completed: '已完成',
  completed_early: '提前完成',
  failed_recoverable: '需要处理'
};

export const StatusBadge = ({state}: {state: RunState}) => (
  <span className={`status status-${state}`}>{labels[state]}</span>
);
