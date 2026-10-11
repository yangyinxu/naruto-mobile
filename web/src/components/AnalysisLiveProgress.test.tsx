import {act, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AiAnalysisActivity} from '../types';
import {AnalysisLiveProgress} from './AnalysisLiveProgress';

const timestamp = '2026-10-11T12:00:00.000Z';
const activity: AiAnalysisActivity = {
  stage: 'detail', screened: 2395, screeningTotal: 2395, detailed: 102, detailTotal: 1200,
  inFlightRequests: 3, inFlightOpinions: 30, retryingRequests: 0,
  startedAt: timestamp, oldestRequestStartedAt: timestamp, lastResultAt: timestamp
};
afterEach(() => {vi.useRealTimers();});

describe('AnalysisLiveProgress', () => {
  it('ticks response waiting time every second while completed counts stay unchanged', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(timestamp) + 10_000);
    render(<AnalysisLiveProgress activity={activity} working connection="connected" updatedAt={timestamp}/>);
    expect(screen.getByText('10 秒')).toBeInTheDocument();
    expect(screen.getByText('102/1200')).toBeInTheDocument();
    expect(screen.getByText('30 条')).toBeInTheDocument();
    act(() => {vi.advanceTimersByTime(2000);});
    expect(screen.getByText('12 秒')).toBeInTheDocument();
    expect(screen.getByText('102/1200')).toBeInTheDocument();
    expect(screen.getByText('0分12秒')).toBeInTheDocument();
  });

  it('shows a retry countdown and freezes the last snapshot when disconnected or paused', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(timestamp));
    const retry = {...activity, inFlightRequests: 0, inFlightOpinions: 0, retryingRequests: 1,
      nextRetryAt: new Date(Date.parse(timestamp) + 15_000).toISOString()};
    const {rerender} = render(<AnalysisLiveProgress activity={retry} working connection="connected" updatedAt={timestamp}/>);
    expect(screen.getByRole('status')).toHaveTextContent('15 秒后重试');
    act(() => {vi.advanceTimersByTime(2000);});
    expect(screen.getByRole('status')).toHaveTextContent('13 秒后重试');
    rerender(<AnalysisLiveProgress activity={retry} working connection="reconnecting" updatedAt={timestamp}/>);
    expect(screen.getByRole('status')).toHaveTextContent('进度连接已断开');
    expect(screen.getByText('0分00秒')).toBeInTheDocument();
    act(() => {vi.advanceTimersByTime(5000);});
    expect(screen.getByText('0分00秒')).toBeInTheDocument();
    rerender(<AnalysisLiveProgress activity={retry} working={false} connection="connected" updatedAt={timestamp}/>);
    expect(screen.getByText('分析已暂停，进度已保存。')).toBeInTheDocument();
    expect(screen.queryByText(/秒后重试/)).not.toBeInTheDocument();
  });
});
