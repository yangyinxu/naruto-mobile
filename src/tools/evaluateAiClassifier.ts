import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadAppConfig} from '../config';
import {ClassificationRecord, ContentRecord, OpinionRecord} from '../domain/types';
import {AiClassifier} from '../processing/aiClassifier';

type GoldSentiment = 'positive' | 'negative' | 'mixed' | 'neutral';
type GoldInformationType = NonNullable<ClassificationRecord['informationType']>;

interface GoldTopicExpectation {
  anyOf: string[];
  sentiment: GoldSentiment;
  evidenceIncludes: string;
}

interface GoldItem {
  id: string;
  text: string;
  expected: {
    reportEligible: boolean;
    informationType?: GoldInformationType;
    topics?: GoldTopicExpectation[];
    severity?: {min: number; max: number};
  };
}

interface EvalError {
  id: string;
  check: string;
  expected: unknown;
  actual: unknown;
}

const config = loadAppConfig();
if (!config.openAiApiKey) throw new Error('请先在 .env 中配置 OPENAI_API_KEY。');

const fixturePath = resolve('test/fixtures/ai-opinion-gold.json');
const gold = JSON.parse(await readFile(fixturePath, 'utf8')) as GoldItem[];
const content: ContentRecord = {
  id: 'ai-gold-content',
  type: 'video',
  url: 'https://www.bilibili.com/video/ai-gold-content',
  title: '火影忍者手游玩家体验讨论',
  description: '用于验证意见筛选边界的匿名固定样本。',
  discoveryKeyword: '火影忍者手游',
  discoveryRank: 1,
  collectedAt: new Date(0).toISOString(),
  metrics: {}
};
const opinions: OpinionRecord[] = gold.map((item) => ({
  id: item.id,
  contentId: content.id,
  contentType: 'video',
  sourceType: 'comment',
  voiceType: 'viewer',
  text: item.text,
  normalizedText: item.text,
  collectedAt: new Date(0).toISOString(),
  likes: 0,
  replies: 0,
  sourceUrl: content.url
}));

const classifier = new AiClassifier({
  apiKey: config.openAiApiKey,
  model: config.aiModel,
  reasoningEffort: config.aiReasoningEffort,
  batchSize: config.aiBatchSize,
  concurrency: config.aiConcurrency
});
const output = await classifier.classifyAll(opinions, [content]);
const resultById = new Map(output.classifications.map((item) => [item.opinionId, item]));
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : 1;

let truePositive = 0;
let trueNegative = 0;
let falsePositive = 0;
let falseNegative = 0;
let informationTypeChecks = 0;
let informationTypeMatches = 0;
let topicChecks = 0;
let topicMatches = 0;
let sentimentChecks = 0;
let sentimentMatches = 0;
let evidenceChecks = 0;
let evidenceMatches = 0;
let groundedEvidenceChecks = 0;
let groundedEvidenceMatches = 0;
let severityChecks = 0;
let severityMatches = 0;
const errors: EvalError[] = [];

for (const item of gold) {
  const result = resultById.get(item.id);
  if (!result) {
    errors.push({id: item.id, check: 'missing_result', expected: 'classification', actual: null});
    if (item.expected.reportEligible) falseNegative += 1;
    else falsePositive += 1;
    continue;
  }

  const expectedEligible = item.expected.reportEligible;
  const actualEligible = result.reportEligible === true;
  if (expectedEligible && actualEligible) truePositive += 1;
  if (!expectedEligible && !actualEligible) trueNegative += 1;
  if (!expectedEligible && actualEligible) falsePositive += 1;
  if (expectedEligible && !actualEligible) falseNegative += 1;
  if (expectedEligible !== actualEligible) {
    errors.push({
      id: item.id,
      check: 'report_eligible',
      expected: expectedEligible,
      actual: {
        reportEligible: actualEligible,
        informationType: result.informationType,
        insightValue: result.insightValue,
        reasonCodes: result.reasonCodes,
        confidence: result.confidence,
        needsReview: result.needsReview
      }
    });
  }

  if (item.expected.informationType) {
    informationTypeChecks += 1;
    if (result.informationType === item.expected.informationType) informationTypeMatches += 1;
    else errors.push({
      id: item.id,
      check: 'information_type',
      expected: item.expected.informationType,
      actual: result.informationType
    });
  }

  for (const evidence of result.evidence ?? []) {
    groundedEvidenceChecks += 1;
    if (normalize(item.text).includes(normalize(evidence.quote))) groundedEvidenceMatches += 1;
    else errors.push({
      id: item.id,
      check: 'grounded_evidence',
      expected: '逐字摘自当前评论',
      actual: evidence
    });
  }

  for (const expectedTopic of item.expected.topics ?? []) {
    topicChecks += 1;
    const actualTopic = expectedTopic.anyOf.find((topic) => result.topics.includes(topic));
    if (!actualTopic) {
      errors.push({
        id: item.id,
        check: 'topic',
        expected: expectedTopic.anyOf,
        actual: result.topics
      });
      continue;
    }
    topicMatches += 1;

    sentimentChecks += 1;
    const actualSentiment = result.topicSentiments[actualTopic];
    if (actualSentiment === expectedTopic.sentiment) sentimentMatches += 1;
    else errors.push({
      id: item.id,
      check: 'sentiment',
      expected: {[actualTopic]: expectedTopic.sentiment},
      actual: {[actualTopic]: actualSentiment}
    });

    evidenceChecks += 1;
    const expectedEvidence = normalize(expectedTopic.evidenceIncludes);
    const matchingEvidence = result.evidence?.find((entry) => normalize(entry.quote).includes(expectedEvidence));
    if (matchingEvidence) evidenceMatches += 1;
    else errors.push({
      id: item.id,
      check: 'evidence',
      expected: {includes: expectedTopic.evidenceIncludes},
      actual: result.evidence
    });
  }

  if (item.expected.severity) {
    severityChecks += 1;
    if (result.severity >= item.expected.severity.min && result.severity <= item.expected.severity.max) {
      severityMatches += 1;
    } else {
      errors.push({
        id: item.id,
        check: 'severity',
        expected: item.expected.severity,
        actual: result.severity
      });
    }
  }
}

const metrics = {
  eligibility: {
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
    specificity: ratio(trueNegative, trueNegative + falsePositive),
    accuracy: ratio(truePositive + trueNegative, gold.length),
    f1: ratio(2 * truePositive, 2 * truePositive + falsePositive + falseNegative)
  },
  informationTypeAccuracy: ratio(informationTypeMatches, informationTypeChecks),
  topicRecall: ratio(topicMatches, topicChecks),
  sentimentAccuracy: ratio(sentimentMatches, sentimentChecks),
  evidenceAccuracy: ratio(evidenceMatches, evidenceChecks),
  groundedEvidenceAccuracy: ratio(groundedEvidenceMatches, groundedEvidenceChecks),
  severityAccuracy: ratio(severityMatches, severityChecks)
};
const gates = {
  eligibilityPrecision: metrics.eligibility.precision >= 0.9,
  eligibilityRecall: metrics.eligibility.recall >= 0.8,
  informationTypeAccuracy: metrics.informationTypeAccuracy >= 0.8,
  topicRecall: metrics.topicRecall >= 0.8,
  sentimentAccuracy: metrics.sentimentAccuracy >= 0.8,
  evidenceAccuracy: metrics.evidenceAccuracy >= 0.9,
  groundedEvidenceAccuracy: metrics.groundedEvidenceAccuracy === 1,
  severityAccuracy: metrics.severityAccuracy >= 0.8
};

console.log(JSON.stringify({
  classifierVersion: classifier.version,
  model: classifier.model,
  reasoningEffort: classifier.reasoningEffort,
  samples: gold.length,
  metrics,
  gates,
  usage: output.usage,
  errors
}, null, 2));
if (Object.values(gates).some((passed) => !passed)) process.exitCode = 1;
