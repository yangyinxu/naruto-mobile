import assert from 'node:assert/strict';
import test from 'node:test';
import {ClassificationRecord, ContentRecord, OpinionRecord, RunManifest} from '../src/domain/types';
import {buildReport, buildReportData} from '../src/processing/reporter';

const manifest: RunManifest = {
  schemaVersion: 1,
  id: '20260827T120000-abcd1234',
  state: 'completed',
  request: {
    name: '详细报告测试',
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
  statusMessage: '调查和报告已经完成。',
  counts: {candidates: 3, contents: 3, opinions: 3, validOpinions: 3, sources: 3, warnings: 0},
  stopReason: 'budget_exhausted',
  reportReady: true
};

const contents: ContentRecord[] = ['A', 'B', 'C'].map((suffix, index) => ({
  id: `BV${suffix}`,
  type: 'video',
  url: `https://www.bilibili.com/video/BV${suffix}`,
  title: `忍者设计讨论 ${suffix}`,
  description: '玩家讨论忍者设计。',
  discoveryKeyword: '火影忍者手游',
  discoveryRank: index + 1,
  collectedAt: '2026-08-27T12:01:00.000Z',
  metrics: {}
}));

const sentimentCases = [
  {sentiment: 'positive' as const, text: '技能还原度很高，奥义动画也很有诚意', claim: '技能还原与奥义表现得到认可'},
  {sentiment: 'mixed' as const, text: '机制很新颖，但是前摇偏长，实战手感不稳定', claim: '机制创新但手感存在问题'},
  {sentiment: 'negative' as const, text: '模型比例失真，技能特效也遮挡判定', claim: '模型与特效影响战斗辨识'}
];

const opinions: OpinionRecord[] = sentimentCases.map((item, index) => ({
  id: `opinion-${index}`,
  contentId: contents[index].id,
  contentType: 'video',
  sourceType: 'comment',
  voiceType: 'viewer',
  text: item.text,
  collectedAt: '2026-08-27T12:02:00.000Z',
  authorUid: `author-${index}`,
  authorName: `玩家${index + 1}`,
  likes: 30 - index,
  replies: index,
  sourceUrl: `${contents[index].url}?comment_root_id=${index}`
}));

const classifications: ClassificationRecord[] = sentimentCases.map((item, index) => ({
  opinionId: opinions[index].id,
  relevanceScore: 0.95,
  relevanceLevel: 'high',
  isValid: true,
  topics: ['忍者设计'],
  topicSentiments: {'忍者设计': item.sentiment},
  emotion: item.sentiment === 'positive' ? 'appreciation' : item.sentiment === 'mixed' ? 'mixed' : 'frustration',
  stance: item.sentiment === 'positive' ? 'praise' : 'complaint',
  severity: index + 2,
  behaviorIntents: [],
  playerSegment: 'unknown',
  actionability: 'high',
  confidence: 0.93,
  classifierVersion: 'ai:gpt-5.6-luna:test',
  matchedTerms: {},
  analysisMode: 'ai',
  insightValue: 'strong',
  claim: item.claim,
  reportEligible: true,
  evidence: [{topic: '忍者设计', quote: item.text}],
  needsReview: false
}));

const quality = {
  generatedAt: '2026-08-27T12:05:00.000Z',
  analysisMode: 'ai',
  aiModel: 'gpt-5.6-luna',
  rawOpinions: 3,
  validOpinions: 3,
  strongOpinions: 3,
  weakOpinions: 0,
  noiseOpinions: 0,
  duplicateOpinions: 0,
  aiUsage: {
    requestCount: 2,
    inputTokens: 2_200,
    cachedInputTokens: 600,
    outputTokens: 500,
    reasoningTokens: 150,
    totalTokens: 2_700,
    estimatedCostUsd: 0.000932,
    pricing: {
      currency: 'USD',
      inputPerMillion: 0.20,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 1.20,
      checkedAt: '2026-08-27',
      sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna'
    }
  }
};

test('builds topic summaries with complete sentiment-separated evidence and Chinese quality details', () => {
  const data = buildReportData(manifest, contents, opinions, classifications, quality);
  assert.equal(data.topics.length, 1);
  assert.match(data.topics[0].summary, /正向 1、混合 1、负向 1/);
  assert.equal(data.topics[0].evidence.positive.length, 1);
  assert.equal(data.topics[0].evidence.mixed.length, 1);
  assert.equal(data.topics[0].evidence.negative.length, 1);
  assert.equal(data.quality.usage?.totalTokens, 2_700);
  assert.equal(data.quality.usage?.estimatedCostUsd, 0.000932);

  const markdown = buildReport(manifest, contents, opinions, classifications, quality);
  assert.match(markdown, /大体总结/);
  assert.match(markdown, /#### 正向意见（1）/);
  assert.match(markdown, /#### 混合意见（1）/);
  assert.match(markdown, /#### 负向意见（1）/);
  assert.match(markdown, /预估费用：约 \$0\.0009 美元/);
  assert.doesNotMatch(markdown, /```json|"analysisMode"/);
});
