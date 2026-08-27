import assert from 'node:assert/strict';
import test from 'node:test';
import {ContentRecord, OpinionRecord} from '../src/domain/types';
import {cleanOpinions, normalizeText} from '../src/processing/cleaner';
import {RuleClassifier} from '../src/processing/ruleClassifier';

const content: ContentRecord = {
  id: 'BV1',
  type: 'video',
  url: 'https://www.bilibili.com/video/BV1',
  title: '火影忍者手游新忍者强度测评',
  discoveryKeyword: '火影忍者手游',
  discoveryRank: 1,
  description: '',
  collectedAt: new Date().toISOString(),
  metrics: {}
};

const opinion = (id: string, text: string): OpinionRecord => ({
  id,
  contentId: content.id,
  contentType: 'video',
  sourceType: 'comment',
  voiceType: 'viewer',
  text,
  collectedAt: new Date().toISOString(),
  likes: 0,
  replies: 0,
  sourceUrl: content.url
});

test('cleans mentions and exact duplicate opinions without mutating raw text', () => {
  const first = opinion('one', '@某人  土豆服务器  https://example.com');
  const result = cleanOpinions([first, opinion('two', '@某人 土豆服务器 https://example.com')]);
  assert.equal(result.opinions.length, 1);
  assert.equal(result.duplicateCount, 1);
  assert.match(result.opinions[0].normalizedText ?? '', /\[用户\]/);
  assert.equal(first.normalizedText, undefined);
});

test('uses the plain public UID to keep different authors distinct', () => {
  const first = {...opinion('uid-one', '同一条公开评论'), authorUid: '10001', authorName: '玩家甲'};
  const second = {...opinion('uid-two', '同一条公开评论'), authorUid: '10002', authorName: '玩家乙'};
  const result = cleanOpinions([first, second]);
  assert.equal(result.opinions.length, 2);
  assert.equal(result.duplicateCount, 0);
});

test('classifies multi-topic sentiment and churn behavior', async () => {
  const classifier = await RuleClassifier.load();
  const item = opinion('three', '这个忍者很帅，但强度太超标，服务器还掉线，真想退游');
  item.normalizedText = normalizeText(item.text);
  const result = classifier.classify(item, content);
  assert.equal(result.isValid, true);
  assert.ok(result.topics.includes('忍者设计'));
  assert.ok(result.topics.includes('忍者强度'));
  assert.ok(result.topics.includes('技术质量'));
  assert.ok(result.behaviorIntents.includes('churn'));
  assert.equal(result.severity, 5);
});

test('rejects unrelated chatter even when the source video is relevant', async () => {
  const classifier = await RuleClassifier.load();
  const unrelated = classifier.classify(opinion('four', '我妈问我985是什么意思'), content);
  const contextual = classifier.classify(opinion('five', '又瞬移了，真离谱'), content);
  assert.equal(unrelated.isValid, false);
  assert.equal(unrelated.invalidReason, 'low_relevance');
  assert.equal(contextual.isValid, true);
  assert.ok(contextual.topics.includes('技术质量'));
});
