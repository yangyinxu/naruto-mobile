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

  it('reconciles overall, local exclusions, Decisions skips and Luna detail without treating overall as Luna', () => {
    const counted = {...activity, screened: 1334, screeningTotal: 1334, detailed: 102, detailTotal: 1292,
      cached: 0, localExcluded: 72, creatorExcluded: 69, noiseExcluded: 3, triageSkipped: 42};
    render(<AnalysisLiveProgress activity={counted} overallCompleted={216} overallTotal={1406} working connection="connected" updatedAt={timestamp}/>);
    expect(screen.getByText('216/1406')).toBeInTheDocument();
    expect(screen.getByText('1334/1334')).toBeInTheDocument();
    expect(screen.getByText('102/1292')).toBeInTheDocument();
    expect(screen.getByText('全部记录 1406 = 复用缓存 0 + 本地排除 72 + Decisions 跳过 42 + 需要详析 1292')).toBeInTheDocument();
    expect(screen.getByText('已完成 216 = 复用缓存 0 + 本地排除 72 + Decisions 跳过 42 + 详析完成 102；待完成 1190 = 详析待完成 1190')).toBeInTheDocument();
    expect(screen.getByText(/本地排除 72 = 作者观点 69 \+ 明确无信息记录 3/)).toBeInTheDocument();
    expect(screen.getByText(/不代表都经过 Luna/)).toBeInTheDocument();
  });

  it('keeps resumed cached routes exclusive from this session local and detailed work', () => {
    const resumed = {...activity, screened: 40, screeningTotal: 40, detailed: 4, detailTotal: 30,
      cached: 20, localExcluded: 10, creatorExcluded: 8, noiseExcluded: 2, triageSkipped: 10};
    render(<AnalysisLiveProgress activity={resumed} overallCompleted={44} overallTotal={70} working connection="connected" updatedAt={timestamp}/>);
    expect(screen.getByText('全部记录 70 = 复用缓存 20 + 本地排除 10 + Decisions 跳过 10 + 需要详析 30')).toBeInTheDocument();
    expect(screen.getByText(/本次统一计入缓存，不再重复计入其他分项/)).toBeInTheDocument();
  });

  it('labels overlapping pipeline detail totals as progressive and includes unscreened records in sums', () => {
    const overlapping: AiAnalysisActivity = {...activity, stage: 'triage', screened: 40, screeningTotal: 90,
      detailed: 5, detailTotal: 30, cached: 0, localExcluded: 10, triageSkipped: 10,
      effectiveConcurrency: 4, configuredConcurrency: 8};
    render(<AnalysisLiveProgress activity={overlapping} overallCompleted={25} overallTotal={100} working connection="connected" updatedAt={timestamp}/>);
    expect(screen.getByText('Decisions 初筛与 Luna 详析同时进行')).toBeInTheDocument();
    expect(screen.getByText('5/30')).toBeInTheDocument();
    expect(screen.getByText(/总量待初筛结束确定/)).toBeInTheDocument();
    expect(screen.getByText('全部记录 100 = 复用缓存 0 + 本地排除 10 + Decisions 跳过 10 + 当前进入详析 30 + 尚待初筛 50')).toBeInTheDocument();
    expect(screen.getByText('已完成 25 = 复用缓存 0 + 本地排除 10 + Decisions 跳过 10 + 详析完成 5；待完成 75 = 详析待完成 25 + 尚待初筛 50')).toBeInTheDocument();
    expect(screen.getByText('4/8')).toBeInTheDocument();
    expect(screen.getByText(/与 Chrome 采集标签页数分别设置/)).toBeInTheDocument();
  });

  it('does not infer missing legacy cache or exclusion counts from the overall remainder', () => {
    render(<AnalysisLiveProgress activity={activity} overallCompleted={300} overallTotal={2500} working connection="connected" updatedAt={timestamp}/>);
    expect(screen.getByText('300/2500')).toBeInTheDocument();
    expect(screen.getByText(/分项无法可靠还原/)).toBeInTheDocument();
    expect(screen.queryByText(/全部记录 2500 =/)).not.toBeInTheDocument();
  });
});
