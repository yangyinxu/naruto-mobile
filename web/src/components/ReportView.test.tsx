import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {ReportData, ReportTopic, RunManifest} from '../types';
import {ReportView} from './ReportView';
import {downloadReportFile} from '../lib/downloadReport';

vi.mock('../lib/downloadReport', () => ({downloadReportFile: vi.fn()}));

const topic = (name: string, suffix: string): ReportTopic => ({
  topic: name,
  summary: `这是${name}的大体总结，说明主要观点与争议。`,
  count: 3,
  positive: 1,
  mixed: 1,
  negative: 1,
  neutral: 0,
  sources: 3,
  authors: 3,
  averageSeverity: 3,
  riskScore: 8,
  netSentiment: -0.17,
  reviewStatus: '达到最低复核门槛',
  evidence: {
    positive: [{id: `${suffix}-p`, sentiment: 'positive', text: `${name}正向原文`, evidence: '正向证据', claim: '正向提炼', severity: 2, confidence: .9, likes: 10, replies: 1, authorName: '玩家甲', sourceTitle: '来源视频', sourceUrl: 'https://example.com/p'}],
    mixed: [{id: `${suffix}-m`, sentiment: 'mixed', text: `${name}混合原文`, evidence: '混合证据', claim: '混合提炼', severity: 3, confidence: .9, likes: 8, replies: 2, authorName: '玩家乙', sourceTitle: '来源视频', sourceUrl: 'https://example.com/m'}],
    negative: [{id: `${suffix}-n`, sentiment: 'negative', text: `${name}负向原文`, evidence: '负向证据', claim: '负向提炼', severity: 4, confidence: .9, likes: 12, replies: 3, authorName: '玩家丙', sourceTitle: '来源视频', sourceUrl: 'https://example.com/n'}],
    neutral: []
  }
});

const data: ReportData = {
  title: '调查报告',
  runId: '20260827T120000-abcd1234',
  generatedAt: '2026-08-27T12:05:00.000Z',
  conclusion: '忍者设计是本次最需要关注的主题。',
  sample: {sourceCount: 7, rawOpinions: 50, validOpinions: 6, topicCount: 2, warnings: 0, confidenceLabel: '可进入人工复核', confidenceExplanation: '已覆盖至少三个独立来源。'},
  topics: [topic('忍者设计', 'design'), topic('忍者强度', 'power')],
  quality: {
    analysisMode: 'ai',
    analysisLabel: 'gpt-5.6-luna AI 结构化筛选',
    model: 'gpt-5.6-luna',
    strongOpinions: 6,
    weakOpinions: 4,
    noiseOpinions: 12,
    duplicateOpinions: 1,
    localHardNoise: 2,
    creatorViewsExcluded: 3,
    cachedAiOpinions: 0,
    detailedAiOpinions: 10,
    usage: {
      requestCount: 2,
      inputTokens: 2_200,
      cachedInputTokens: 600,
      outputTokens: 500,
      reasoningTokens: 150,
      totalTokens: 2_700,
      estimatedCostUsd: 0.000932,
      pricing: {currency: 'USD', inputPerMillion: .2, cachedInputPerMillion: .02, outputPerMillion: 1.2, checkedAt: '2026-08-27', sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna'}
    },
    usageExplanation: 'Token 来自本次 API 返回的实际 usage。'
  },
  limitations: ['热门优先采样不代表全部玩家。']
};

const apiMocks = vi.hoisted(() => ({
  report: vi.fn(),
  reportData: vi.fn(),
  openFolder: vi.fn()
}));

vi.mock('../lib/api', () => ({api: apiMocks}));

const run: RunManifest = {
  id: data.runId,
  state: 'completed',
  request: {name: '火影手游玩家反馈调查', durationMinutes: 5, contentWindowDays: 30, keywords: ['火影忍者手游'], includeVideos: true, includeArticles: false, mode: 'live', browserVisible: true, browserWindowCount: 1, maxSources: 20},
  createdAt: data.generatedAt,
  updatedAt: data.generatedAt,
  activeElapsedMs: 300_000,
  statusMessage: '完成',
  progress: {phase: 'completed'},
  counts: {candidates: 7, contents: 7, opinions: 50, validOpinions: 6, sources: 7, warnings: 0},
  reportReady: true
};

describe('ReportView', () => {
  it('exports the full HTML dossier regardless of the currently selected topic and sentiment', async () => {
    apiMocks.report.mockResolvedValue('# 完整报告');
    apiMocks.reportData.mockResolvedValue(data);
    render(<ReportView run={run} onBack={vi.fn()} onError={vi.fn()}/>);
    await screen.findByText('忍者设计负向原文');
    fireEvent.click(screen.getByRole('button', {name: /忍者强度.*查看完整详情/}));
    fireEvent.click(screen.getByRole('tab', {name: /混合/}));
    fireEvent.click(screen.getByRole('button', {name: '导出 HTML'}));
    await waitFor(() => expect(downloadReportFile).toHaveBeenCalledWith(
      expect.stringContaining('<!doctype html>'), run.request.name, 'html'
    ));
    const html = vi.mocked(downloadReportFile).mock.calls.find((call) => call[2] === 'html')![0];
    for (const name of ['忍者设计', '忍者强度']) {
      for (const sentiment of ['正向', '混合', '负向']) expect(html).toContain(`${name}${sentiment}原文`);
    }
    fireEvent.click(screen.getByRole('button', {name: '导出 Markdown'}));
    expect(downloadReportFile).toHaveBeenCalledWith('# 完整报告', run.request.name, 'md');
  });
  it('shows Decisions and Luna costs separately while preserving historical usage displays', async () => {
    apiMocks.report.mockResolvedValue('# 报告');
    apiMocks.reportData.mockResolvedValue({...data, quality: {...data.quality, usage: {
      ...data.quality.usage!,
      stages: {
        triage: {requestCount: 1, inputTokens: 1000, estimatedCostUsd: 0.0001},
        detail: {requestCount: 1, inputTokens: 1200, estimatedCostUsd: 0.000234}
      },
      pricing: {...data.quality.usage!.pricing!, decisionsSourceUrl: 'https://developers.openai.com/api/docs/guides/decisions'}
    }}});
    render(<ReportView run={run} onBack={vi.fn()} onError={vi.fn()}/>);
    expect(await screen.findByText('Decisions 初筛')).toBeInTheDocument();
    expect(screen.getByText('Luna 详析')).toBeInTheDocument();
    expect(screen.getByRole('link', {name: /查看 Decisions 初筛单价/})).toHaveAttribute('href', 'https://developers.openai.com/api/docs/guides/decisions');
  });
  it('navigates topics, separates sentiment sections, and explains Luna usage in Chinese', async () => {
    apiMocks.report.mockResolvedValue('# 完整报告');
    apiMocks.reportData.mockResolvedValue(data);
    apiMocks.openFolder.mockResolvedValue({ok: true});
    render(<ReportView run={run} onBack={vi.fn()} onError={vi.fn()}/>);
    expect(await screen.findByText('忍者设计负向原文')).toBeInTheDocument();
    expect(screen.getByText('2,700 Token')).toBeInTheDocument();
    expect(screen.getByText('约 $0.0009 美元')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', {name: /混合/}));
    expect(screen.getByText('忍者设计混合原文')).toBeInTheDocument();
    expect(screen.queryByText('忍者设计负向原文')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {name: /忍者强度.*查看完整详情/}));
    expect(screen.getByText('忍者强度负向原文')).toBeInTheDocument();
    expect(screen.getAllByText('这是忍者强度的大体总结，说明主要观点与争议。')).toHaveLength(2);
  });

  it('distinguishes report eligible records, overlapping topic evidence and token subsets', async () => {
    apiMocks.report.mockResolvedValue('# 报告');
    apiMocks.reportData.mockResolvedValue({...data, sample: {...data.sample, validOpinions: 5}});
    render(<ReportView run={run} onBack={vi.fn()} onError={vi.fn()}/>);
    await screen.findByText('忍者设计负向原文');
    const quality = screen.getByLabelText('数据质量与 Luna 用量');
    expect(within(quality).getByText('进入报告').parentElement).toHaveTextContent('5 条');
    expect(within(quality).getByText('全部强洞察').parentElement).toHaveTextContent('6 条');
    expect(screen.getByText(/已分类观众记录 22 = 强洞察 6 \+ 弱信号 4 \+ 无参考价值 12/)).toBeInTheDocument();
    expect(screen.getByText(/本主题证据 3 条 = 正向 1 \+ 混合 1 \+ 负向 1 \+ 中性 0/)).toBeInTheDocument();
    expect(screen.getByText(/各主题证据数不能相加/)).toBeInTheDocument();
    expect(screen.getByText('2,200 输入 + 500 输出')).toBeInTheDocument();
    expect(screen.getByText(/缓存读取与缓存写入是输入 Token 的子集；推理是输出 Token 的子集/)).toBeInTheDocument();
    expect(screen.getByText('其中推理 150，已包含在输出内')).toBeInTheDocument();
  });
});
