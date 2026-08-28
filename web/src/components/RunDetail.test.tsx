import {render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {RunManifest} from '../types';
import {RunDetail} from './RunDetail';

vi.mock('../hooks/useRunStream', () => ({
  useRunStream: (_runId: string, initial: RunManifest) => [initial, vi.fn()]
}));

vi.mock('../lib/api', () => ({
  api: {runDetail: vi.fn().mockResolvedValue({events: []})}
}));

const run: RunManifest = {
  id: '20260827T120000-abcd1234',
  state: 'processing',
  request: {
    name: '火影手游玩家反馈调查',
    durationMinutes: 5,
    contentWindowDays: 30,
    keywords: ['火影忍者手游'],
    includeVideos: true,
    includeDynamics: false,
    mode: 'live',
    browserVisible: true,
    browserWindowCount: 1,
    maxSources: 20
  },
  createdAt: '2026-08-27T12:00:00.000Z',
  updatedAt: '2026-08-27T12:05:00.000Z',
  activeElapsedMs: 300_000,
  statusMessage: 'Luna 正在分析意见：544/651',
  progress: {phase: 'analyzing', completed: 544, total: 651},
  counts: {candidates: 4, contents: 3, opinions: 651, validOpinions: 0, sources: 3, warnings: 0},
  reportReady: false
};

describe('RunDetail', () => {
  it('shows an activity indicator while Luna is analyzing', () => {
    render(<RunDetail initial={run} onBack={vi.fn()} onReport={vi.fn()} onError={vi.fn()}/>);
    expect(screen.getByLabelText('当前步骤仍在进行中')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', {name: '调查总进度'})).toHaveAttribute('aria-valuenow', '71');
    expect(screen.getByText('Luna 分析')).toHaveClass('active');
    expect(screen.getByText('Luna 分析中', {selector: '.status'})).toBeInTheDocument();
  });

  it('shows report generation as a separate phase', () => {
    render(<RunDetail initial={{...run, statusMessage: 'Luna 已完成意见分析，正在生成报告…', progress: {phase: 'reporting'}}} onBack={vi.fn()} onReport={vi.fn()} onError={vi.fn()}/>);
    expect(screen.getByLabelText('当前步骤仍在进行中')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', {name: '调查总进度'})).toHaveAttribute('aria-valuenow', '75');
    expect(screen.getByText('生成报告', {selector: '.progress-stages span'})).toHaveClass('active');
    expect(screen.getByText('生成报告', {selector: '.status'})).toBeInTheDocument();
  });

  it('reaches 100% only after the report is ready', () => {
    render(<RunDetail initial={{...run, state: 'completed', reportReady: true, progress: {phase: 'completed'}}} onBack={vi.fn()} onReport={vi.fn()} onError={vi.fn()}/>);
    expect(screen.queryByLabelText('当前步骤仍在进行中')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', {name: '调查总进度'})).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('生成报告', {selector: '.progress-stages span'})).toHaveClass('done');
  });

  it('returns an interrupted run to the collection stage when it is paused', () => {
    render(<RunDetail initial={{...run, state: 'paused', statusMessage: '上次运行被关闭，进度已保留。'}} onBack={vi.fn()} onReport={vi.fn()} onError={vi.fn()}/>);
    expect(screen.getByText('收集意见')).toHaveClass('active');
    expect(screen.getByText('Luna 分析')).not.toHaveClass('active');
    expect(screen.queryByLabelText('当前步骤仍在进行中')).not.toBeInTheDocument();
  });
});
