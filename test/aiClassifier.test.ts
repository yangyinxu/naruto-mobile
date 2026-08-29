import assert from 'node:assert/strict';
import test from 'node:test';
import {ContentRecord, OpinionRecord} from '../src/domain/types';
import {AiClassifier} from '../src/processing/aiClassifier';

const content: ContentRecord = {
  id: 'BVAI001',
  type: 'video',
  url: 'https://www.bilibili.com/video/BVAI001',
  title: '火影忍者手游新忍者实战测评',
  description: '测试新忍者强度、技能后摇和决斗场表现。',
  discoveryKeyword: '火影忍者手游',
  discoveryRank: 1,
  collectedAt: '2026-08-27T00:00:00.000Z',
  metrics: {}
};

const opinion = (overrides: Partial<OpinionRecord>): OpinionRecord => ({
  id: 'root-opinion',
  contentId: content.id,
  contentType: 'video',
  sourceType: 'comment',
  voiceType: 'viewer',
  text: '这个忍者二技能后摇太长，替身后完全无法反打',
  collectedAt: '2026-08-27T00:01:00.000Z',
  authorUid: '123456',
  authorName: '不应发送的用户名',
  authorProfileUrl: 'https://space.bilibili.com/123456',
  authorHash: 'private-author-hash',
  sourceRecordId: 'r1',
  likes: 20,
  replies: 1,
  sourceUrl: content.url,
  ...overrides
});

const aiResult = (opinionId: string, insightValue: 'strong' | 'weak') => ({
  opinionId,
  gameRelevant: true,
  relevanceScore: 0.96,
  insightValue,
  informationType: insightValue === 'strong' ? 'product_feedback' : 'community_chatter',
  claimObject: insightValue === 'strong' ? '二技能后摇' : '',
  claim: insightValue === 'strong' ? '二技能后摇过长导致替身后无法反打' : '',
  specificitySignals: insightValue === 'strong' ? ['mechanism', 'impact'] : [],
  reasonCodes: [insightValue === 'strong' ? 'specific_mechanic_issue' : 'missing_context'],
  topics: insightValue === 'strong' ? [{
    name: '决斗场体验',
    sentiment: 'negative',
    evidence: '二技能后摇太长'
  }] : [],
  emotion: 'frustration',
  stance: 'complaint',
  severity: insightValue === 'strong' ? 4 : 2,
  behaviorIntents: [],
  playerSegment: 'unknown',
  actionability: insightValue === 'strong' ? 'high' : 'low',
  confidence: 0.93,
  needsReview: insightValue === 'weak'
});

test('keeps proxy detail batches within the server protocol limit', () => {
  const classifier = new AiClassifier({
    proxy: {
      baseUrl: 'https://kashewt.com/naruto-mobile/api/v1',
      request: async () => new Response('{}', {status: 200})
    },
    batchSize: 50
  });

  assert.equal(classifier.batchSize, 10);
});

test('uses Luna structured outputs, includes parent context, and excludes author identity', async () => {
  const opinions = [
    opinion({}),
    opinion({
      id: 'reply-opinion',
      sourceType: 'reply',
      text: '确实，根本没法反打',
      sourceRecordId: 'r2',
      parentSourceRecordId: 'r1',
      likes: 3,
      replies: 0
    })
  ];
  let requestBody = '';
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? '');
    const body = JSON.parse(requestBody) as {text?: {format?: {name?: string}}};
    if (body.text?.format?.name === 'naruto_opinion_triage_batch') {
      return new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: JSON.stringify({results: opinions.map((item) => ({
              opinionId: item.id,
              decision: 'analyze',
              gameRelevant: true,
              informationType: 'product_feedback',
              reasonCode: 'possible_product_feedback'
            }))})
          }]
        }],
        usage: {
          input_tokens: 1_000,
          input_tokens_details: {cached_tokens: 200},
          output_tokens: 200,
          output_tokens_details: {reasoning_tokens: 50},
          total_tokens: 1_200
        }
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    return new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({results: [
            aiResult('root-opinion', 'strong'),
            aiResult('reply-opinion', 'weak')
          ]})
        }]
      }],
      usage: {
        input_tokens: 1_200,
        input_tokens_details: {cached_tokens: 400},
        output_tokens: 300,
        output_tokens_details: {reasoning_tokens: 100},
        total_tokens: 1_500
      }
    }), {status: 200, headers: {'content-type': 'application/json'}});
  }) as typeof fetch;
  const classifier = new AiClassifier({
    apiKey: 'test-key-never-sent-to-output',
    fetchImpl,
    batchSize: 10,
    concurrency: 1,
    sleep: async () => undefined
  });
  const output = await classifier.classifyAll(opinions, [content]);

  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assert.equal(body.model, 'gpt-5.6-luna');
  assert.deepEqual(body.reasoning, {effort: 'medium'});
  assert.equal(body.store, false);
  assert.match(requestBody, /根本没法反打/);
  assert.match(requestBody, /二技能后摇太长/);
  assert.doesNotMatch(requestBody, /不应发送的用户名|123456|private-author-hash|space\.bilibili/);
  assert.equal(output.classifications[0].reportEligible, true);
  assert.equal(output.classifications[0].insightValue, 'strong');
  assert.equal(output.classifications[1].reportEligible, false);
  assert.equal(output.classifications[1].insightValue, 'weak');
  assert.equal(output.newCacheRecords.length, 2);
  assert.deepEqual({
    requestCount: output.usage.requestCount,
    inputTokens: output.usage.inputTokens,
    cachedInputTokens: output.usage.cachedInputTokens,
    outputTokens: output.usage.outputTokens,
    reasoningTokens: output.usage.reasoningTokens,
    totalTokens: output.usage.totalTokens
  }, {
    requestCount: 2,
    inputTokens: 2_200,
    cachedInputTokens: 600,
    outputTokens: 500,
    reasoningTokens: 150,
    totalTokens: 2_700
  });
  assert.ok(Math.abs((output.usage.estimatedCostUsd ?? 0) - 0.000932) < 1e-12);
  assert.equal(output.usage.pricing?.outputPerMillion, 1.20);

  const cachedClassifier = new AiClassifier({
    apiKey: 'test-key',
    fetchImpl: (async () => {
      throw new Error('cache should prevent API requests');
    }) as typeof fetch
  });
  const cached = await cachedClassifier.classifyAll(opinions, [content], output.newCacheRecords);
  assert.equal(cached.cachedCount, 2);
  assert.equal(cached.classifications.length, 2);
  assert.equal(cached.usage.requestCount, 0);
  assert.equal(cached.usage.totalTokens, 0);
  assert.equal(cached.usage.estimatedCostUsd, 0);
});

test('uses authenticated Archtree proxy requests without sending an OpenAI key or author identity', async () => {
  const seen: Array<{url: string; authorization: string; body: Record<string, unknown>}> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {kind: 'triage' | 'detail'; batch: Array<{opinionId: string}>};
    seen.push({
      url: String(url),
      authorization: String(new Headers(init?.headers).get('authorization')),
      body
    });
    const results = body.kind === 'triage' ? [{
      opinionId: 'root-opinion', decision: 'analyze', gameRelevant: true,
      informationType: 'product_feedback', reasonCode: 'possible_product_feedback'
    }] : [aiResult('root-opinion', 'strong')];
    return new Response(JSON.stringify({
      protocolVersion: 1,
      kind: body.kind,
      promptVersion: body.kind === 'triage' ? 'naruto-triage-v3' : 'naruto-opinion-v3',
      model: 'gpt-5.6-luna',
      results,
      usage: {inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 5, totalTokens: 130}
    }), {status: 200, headers: {'content-type': 'application/json'}});
  }) as typeof fetch;
  const authenticatedRequest = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    headers.set('authorization', 'Bearer archtree-access-token');
    return fetchImpl(url, {...init, headers});
  };
  const classifier = new AiClassifier({
    proxy: {baseUrl: 'https://kashewt.com/naruto-mobile/api/v1', request: authenticatedRequest},
    fetchImpl,
    concurrency: 1,
    sleep: async () => undefined
  });
  const output = await classifier.classifyAll([opinion({})], [content]);

  assert.equal(seen.length, 2);
  assert.ok(seen.every((item) => item.url.endsWith('/classify')));
  assert.ok(seen.every((item) => item.authorization === 'Bearer archtree-access-token'));
  const serialized = JSON.stringify(seen);
  assert.doesNotMatch(serialized, /OPENAI_API_KEY|不应发送的用户名|123456|private-author-hash|space\.bilibili/);
  assert.equal(output.classifications[0].reportEligible, true);
  assert.equal(output.usage.requestCount, 2);
  assert.equal(output.usage.totalTokens, 260);
});
