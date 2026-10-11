import {decisionsResponse} from './fixtures/decisionsResponse';
import assert from 'node:assert/strict';
import test from 'node:test';
import {ContentRecord, OpinionRecord} from '../src/domain/types';
import {AiClassificationProgress, AiClassifier} from '../src/processing/aiClassifier';

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

test('publishes screening and in-flight progress before results, then commits concurrent batches monotonically', async () => {
  const opinions = ['one', 'two'].map((id) => opinion({id}));
  const updates: AiClassificationProgress[] = [];
  let releaseTriage!: () => void;
  const triageGate = new Promise<void>((resolve) => {releaseTriage = resolve;});
  let triageStarted!: () => void;
  const triageReady = new Promise<void>((resolve) => {triageStarted = resolve;});
  const releases = new Map<string, () => void>();
  const gates = new Map(opinions.map(({id}) => [id, new Promise<void>((resolve) => {releases.set(id, resolve);})]));
  let detailsStarted!: () => void;
  const detailsReady = new Promise<void>((resolve) => {detailsStarted = resolve;});
  let detailRequests = 0;
  let firstSaved!: () => void;
  const firstResult = new Promise<void>((resolve) => {firstSaved = resolve;});
  const classifier = new AiClassifier({apiKey: 'test-key', batchSize: 1, concurrency: 2,
    fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/decisions')) {
        triageStarted();
        await triageGate;
        return new Response(JSON.stringify(decisionsResponse(['one', 'two'])));
      }
      const id = JSON.parse(JSON.parse(String(init?.body)).input).batch[0].opinionId as string;
      if (++detailRequests === 2) detailsStarted();
      await gates.get(id);
      return new Response(JSON.stringify({output_text: JSON.stringify({results: [aiResult(id, 'strong')]})}));
    }) as typeof fetch});
  const pending = classifier.classifyAll(opinions, [content], [], async (progress, records) => {
    assert.ok(progress.completed >= (updates.at(-1)?.completed ?? 0));
    updates.push(progress);
    if (records.some((record) => record.opinionId === 'one')) firstSaved();
  });
  try {
    await triageReady;
    assert.equal(updates.at(-1)?.completed, 0);
    assert.equal(updates.at(-1)?.activity?.inFlightOpinions, 2);
    assert.equal(updates.at(-1)?.activity?.stage, 'triage');
    releaseTriage();
    await detailsReady;
    assert.equal(updates.at(-1)?.activity?.screened, 2);
    assert.equal(updates.at(-1)?.activity?.inFlightRequests, 2);
    assert.equal(updates.at(-1)?.completed, 0);
    releases.get('one')!();
    await firstResult;
    assert.equal(updates.at(-1)?.completed, 1);
    assert.equal(updates.at(-1)?.activity?.detailed, 1);
    assert.equal(updates.at(-1)?.activity?.inFlightRequests, 1);
    assert.ok(updates.at(-1)?.activity?.lastResultAt);
  } finally {
    releaseTriage();
    for (const release of releases.values()) release();
    await pending;
  }
  assert.equal(updates.at(-1)?.completed, 2);
  assert.equal(updates.at(-1)?.activity?.inFlightRequests, 0);
  assert.equal(updates.at(-1)?.activity?.detailed, 2);
});

test('exposes Retry-After waits without advancing completed results', async () => {
  const updates: AiClassificationProgress[] = [];
  let attempts = 0;
  const classifier = new AiClassifier({apiKey: 'test-key', concurrency: 1,
    sleep: async (milliseconds) => {
      assert.equal(milliseconds, 60_000);
      const progress = updates.at(-1)!;
      assert.equal(progress.completed, 0);
      assert.equal(progress.activity?.retryingRequests, 1);
      assert.equal(progress.activity?.inFlightRequests, 0);
      assert.ok(Date.parse(progress.activity!.nextRetryAt!) >= Date.now() + 59_000);
    },
    fetchImpl: (async (url) => {
      if (String(url).endsWith('/decisions')) return new Response(JSON.stringify(decisionsResponse(['root-opinion'])));
      if (++attempts === 1) return new Response('{}', {status: 429, headers: {'retry-after': '60'}});
      return new Response(JSON.stringify({output_text: JSON.stringify({results: [aiResult('root-opinion', 'strong')]})}));
    }) as typeof fetch});
  await classifier.classifyAll([opinion({})], [content], [], async (progress) => {updates.push(progress);});
  assert.equal(updates.at(-1)?.completed, 1);
  assert.equal(updates.at(-1)?.activity?.retryingRequests, 0);
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
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('OpenAI-Organization'), 'org-test');
    assert.equal(headers.get('OpenAI-Project'), 'proj-test');
    requestBody = String(init?.body ?? '');
    const body = JSON.parse(requestBody) as {text?: {format?: {name?: string}}};
    if (String(_url).endsWith('/decisions')) {
      assert.equal((body as any).model, 'gpt-6-luna');
      assert.equal((body as any).questions.length, 6);
      assert.match(requestBody, /根本没法反打/);
      assert.doesNotMatch(requestBody, /不应发送的用户名|123456|private-author-hash|space\.bilibili/);
      return new Response(JSON.stringify(decisionsResponse(opinions.map((item) => item.id))), {status: 200});
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
    organizationId: 'org-test',
    projectId: 'proj-test',
    fetchImpl,
    batchSize: 10,
    concurrency: 1,
    sleep: async () => undefined
  });
  const output = await classifier.classifyAll(opinions, [content]);

  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assert.equal(body.model, 'gpt-6-luna');
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
    outputTokens: 300,
    reasoningTokens: 100,
    totalTokens: 2_500
  });
  assert.ok(Math.abs((output.usage.estimatedCostUsd ?? 0) - 0.000334) < 1e-12);
  assert.equal(output.usage.pricing?.outputPerMillion, 0.50);
  assert.equal(output.usage.stages?.triage.requestCount, 1);
  assert.ok(Math.abs(output.usage.stages!.triage.estimatedCostUsd! - 0.0001) < 1e-12);
  assert.ok(Math.abs(output.usage.stages!.detail.estimatedCostUsd! - 0.000234) < 1e-12);

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
      promptVersion: body.kind === 'triage' ? 'naruto-decisions-v1' : 'naruto-opinion-v4',
      model: 'gpt-6-luna',
      results,
      usage: {inputTokens: 100, cachedInputTokens: 20, outputTokens: body.kind === 'triage' ? 0 : 30, reasoningTokens: body.kind === 'triage' ? 0 : 5, totalTokens: body.kind === 'triage' ? 100 : 130}
    }), {status: 200, headers: {'content-type': 'application/json'}});
  }) as typeof fetch;
  const authenticatedRequest = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('OpenAI-Organization'), false);
    assert.equal(headers.has('OpenAI-Project'), false);
    headers.set('authorization', 'Bearer archtree-access-token');
    return fetchImpl(url, {...init, headers});
  };
  const classifier = new AiClassifier({
    proxy: {baseUrl: 'https://kashewt.com/naruto-mobile/api/v1', request: authenticatedRequest},
    apiKey: 'unused-local-key',
    organizationId: 'org-local-unused',
    projectId: 'proj-local-unused',
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
  assert.equal(output.usage.totalTokens, 230);
});

test('retains comments for detailed analysis after refused, malformed or exhausted screening', async () => {
  for (const mode of ['refusal', 'malformed', 'rate-limit', 'usage'] as const) {
    const seen: string[] = [];
    const delays: number[] = [];
    const classifier = new AiClassifier({apiKey: 'test-key', concurrency: 1,
      sleep: async (delay) => {delays.push(delay);},
      fetchImpl: (async (url, init) => {
        seen.push(String(url));
        if (String(url).endsWith('/decisions')) {
          if (mode === 'rate-limit') return new Response('{}', {status: 429, headers: {'retry-after': '2'}});
          const response = decisionsResponse(['root-opinion'], {decision: 'skip', informationType: 'community_chatter'});
          if (mode === 'refusal') Object.assign(response.answers[0], {type: 'refusal'});
          else if (mode === 'usage') response.usage.output_tokens = 1;
          else response.answers.pop();
          return new Response(JSON.stringify(response), {status: 200});
        }
        const batch = JSON.parse(JSON.parse(String(init?.body)).input).batch;
        assert.equal(batch[0].opinionId, 'root-opinion');
        return new Response(JSON.stringify({output_text: JSON.stringify({results: [aiResult('root-opinion', 'strong')]}),
          usage: {input_tokens: 100, output_tokens: 10, total_tokens: 110}}), {status: 200});
      }) as typeof fetch
    });
    const output = await classifier.classifyAll([opinion({})], [content]);
    assert.equal(output.classifications[0].reportEligible, true, mode);
    assert.equal(output.fastTriageSkippedCount, 0);
    assert.equal(output.detailedCount, 1);
    assert.equal(seen.at(-1), 'https://api.openai.com/v1/responses');
    if (mode === 'rate-limit') {
      assert.equal(seen.length, 7);
      assert.equal(delays.length, 5);
      assert.ok(delays[0] >= 2000);
    }
  }
});

test('charges Decisions input and Responses cache writes at their distinct rates', async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/decisions')) {
        return new Response(JSON.stringify(decisionsResponse(['root-opinion'])), {status: 200});
      }
      return new Response(JSON.stringify({output_text: JSON.stringify({results: [aiResult('root-opinion', 'strong')]}),
        usage: {input_tokens: 1000, input_tokens_details: {cached_tokens: 200, cache_write_tokens: 300},
          output_tokens: 100, total_tokens: 1100}}), {status: 200});
    }) as typeof fetch;
  const classifier = new AiClassifier({apiKey: 'test-key', concurrency: 1, fetchImpl});
  const output = await classifier.classifyAll([opinion({})], [content]);
  // Decisions: 1000 * .10; detail: 500 * .10 + 200 * .01 + 300 * .125 + 100 * .50, per million.
  assert.ok(Math.abs(output.usage.estimatedCostUsd! - 0.0002395) < 1e-12);
  assert.equal(output.usage.cacheWriteInputTokens, 300);
  const changed = new AiClassifier({apiKey: 'test-key', model: 'gpt-5.6-luna', fetchImpl, concurrency: 1});
  const reclassified = await changed.classifyAll([opinion({})], [content], output.newCacheRecords);
  assert.equal(reclassified.cachedCount, 0);
  assert.equal(reclassified.usage.estimatedCostUsd, undefined);
});

test('confident screening skips avoid Responses calls entirely', async () => {
  const classifier = new AiClassifier({apiKey: 'test-key', fetchImpl: (async (url) => {
    assert.equal(String(url), 'https://api.openai.com/v1/decisions');
    return new Response(JSON.stringify(decisionsResponse(['root-opinion'], {
      decision: 'skip', informationType: 'community_chatter'
    })), {status: 200});
  }) as typeof fetch});
  const output = await classifier.classifyAll([opinion({text: '这个胜率也太高了吧'})], [content]);
  assert.equal(output.fastTriageSkippedCount, 1);
  assert.equal(output.detailedCount, 0);
  assert.equal(output.classifications[0].reportEligible, false);
  assert.equal(output.usage.estimatedCostUsd, 0.0001);
});

test('retries transport failures and respects an HTTP-date Retry-After', async () => {
  const delays: number[] = [];
  let attempts = 0;
  const retryAt = new Date(Date.now() + 10_000).toUTCString();
  const classifier = new AiClassifier({apiKey: 'test-key', sleep: async (delay) => {delays.push(delay);},
    fetchImpl: (async (url) => {
      if (String(url).endsWith('/decisions')) return new Response(JSON.stringify(decisionsResponse(['root-opinion'])));
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      if (attempts === 2) return new Response('{}', {status: 429, headers: {'retry-after': retryAt}});
      return new Response(JSON.stringify({output_text: JSON.stringify({results: [aiResult('root-opinion', 'strong')]})}));
    }) as typeof fetch});
  const output = await classifier.classifyAll([opinion({})], [content]);
  assert.equal(output.classifications.length, 1);
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays[1] >= 8_000);
});

test('quota exhaustion is not retried as a rate limit', async () => {
  let details = 0;
  const classifier = new AiClassifier({apiKey: 'test-key',
    sleep: async () => {assert.fail('Quota exhaustion must not retry');},
    fetchImpl: (async (url) => {
      if (String(url).endsWith('/decisions')) return new Response(JSON.stringify(decisionsResponse(['root-opinion'])));
      details += 1;
      return new Response(JSON.stringify({error: {code: 'insufficient_quota', message: 'quota exhausted'}}), {status: 429});
    }) as typeof fetch});
  await assert.rejects(classifier.classifyAll([opinion({})], [content]), /quota exhausted/);
  assert.equal(details, 1);
});

test('splits exhausted proxy gateway failures without exceeding concurrency', async () => {
  const opinions = [opinion({id: 'one'}), opinion({id: 'two'})];
  let active = 0;
  let maximumActive = 0;
  const sizes: number[] = [];
  const classifier = new AiClassifier({concurrency: 1, sleep: async () => undefined,
    proxy: {baseUrl: 'https://example.com/api', request: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {kind: string; batch: Array<{opinionId: string}>};
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      if (body.kind === 'detail') {
        sizes.push(body.batch.length);
        if (body.batch.length > 1) return new Response(JSON.stringify({code: 'upstream_unavailable',
          message: 'The analysis service is temporarily unavailable.'}), {status: 502});
      }
      return new Response(JSON.stringify({protocolVersion: 1, kind: body.kind, model: 'gpt-6-luna',
        promptVersion: body.kind === 'triage' ? 'naruto-decisions-v1' : 'naruto-opinion-v4',
        results: body.batch.map(({opinionId}) => body.kind === 'triage'
          ? {opinionId, decision: 'analyze', gameRelevant: true, informationType: 'product_feedback', reasonCode: 'feedback'}
          : aiResult(opinionId, 'strong')),
        usage: {inputTokens: 100, outputTokens: 0, totalTokens: 100}}));
    }}});
  assert.equal((await classifier.classifyAll(opinions, [content])).classifications.length, 2);
  assert.deepEqual(sizes, [2, 2, 2, 2, 2, 2, 1, 1]);
  assert.equal(maximumActive, 1);
});

test('drains concurrent cache writes before failing, stops new batches, and reuses saved results', async () => {
  const opinions = ['one', 'two', 'three'].map((id) => opinion({id}));
  const saved: Awaited<ReturnType<AiClassifier['classifyAll']>>['newCacheRecords'] = [];
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => {releaseSecond = resolve;});
  let secondStarted!: () => void;
  const secondReady = new Promise<void>((resolve) => {secondStarted = resolve;});
  let failFirst!: () => void;
  const failureGate = new Promise<void>((resolve) => {failFirst = resolve;});
  const requested: string[] = [];
  const classifier = new AiClassifier({apiKey: 'test-key', batchSize: 1, concurrency: 2,
    fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/decisions')) return new Response(JSON.stringify(decisionsResponse(opinions.map((item) => item.id))));
      const id = JSON.parse(JSON.parse(String(init?.body)).input).batch[0].opinionId as string;
      requested.push(id);
      if (id === 'one') {
        await failureGate;
        return new Response(JSON.stringify({error: {message: 'login required'}}), {status: 401});
      }
      if (id === 'two') {secondStarted(); await secondGate;}
      return new Response(JSON.stringify({output_text: JSON.stringify({results: [aiResult(id, 'strong')]})}));
    }) as typeof fetch});
  let settled = false;
  const pending = classifier.classifyAll(opinions, [content], [], async (_progress, records) => {
    saved.push(...records);
  }).then(() => {settled = true;}, (error) => {settled = true; throw error;});
  const failed = assert.rejects(pending, /login required/);
  await secondReady;
  failFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseSecond();
  await failed;
  assert.deepEqual(requested, ['one', 'two']);
  assert.deepEqual(saved.map((record) => record.opinionId), ['two']);
  const resumed = new AiClassifier({apiKey: 'test-key', batchSize: 1,
    fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/decisions')) return new Response(JSON.stringify(decisionsResponse(['one', 'three'])));
      const ids = JSON.parse(JSON.parse(String(init?.body)).input).batch.map((item: {opinionId: string}) => item.opinionId) as string[];
      assert.ok(!ids.includes('two'));
      return new Response(JSON.stringify({output_text: JSON.stringify({results: ids.map((id) => aiResult(id, 'strong'))})}));
    }) as typeof fetch});
  const output = await resumed.classifyAll(opinions, [content], saved);
  assert.equal(output.cachedCount, 1);
  assert.equal(output.classifications.length, 3);
});
