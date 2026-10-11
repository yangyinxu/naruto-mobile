import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {AppConfig} from '../src/config';
import {ContentRecord, OpinionRecord, RunManifest} from '../src/domain/types';
import {normalizeResearchRequest} from '../src/domain/validation';
import {FileRunStore} from '../src/infrastructure/fileRunStore';
import {AiClassificationProgress} from '../src/processing/aiClassifier';
import {ArchtreeAuthService} from '../src/services/archtreeAuth';
import {RunManager} from '../src/services/runManager';

const source: ContentRecord = {
  id: 'count-source', type: 'video', url: 'https://example.test/count-source',
  title: '火影手游技能后摇评价', description: '公开评论测试',
  discoveryKeyword: '火影手游', discoveryRank: 1,
  collectedAt: '2026-10-11T00:00:00.000Z', metrics: {}
};

const opinion = (id: string, text: string, overrides: Partial<OpinionRecord> = {}): OpinionRecord => ({
  id, contentId: source.id, contentType: 'video', sourceType: 'comment', voiceType: 'viewer',
  text, collectedAt: source.collectedAt, sourceUrl: source.url,
  authorUid: 'same-public-test-author', likes: 0, replies: 0, ...overrides
});

const records = () => [
  opinion('detail', '这个忍者二技能后摇太长，替身后完全无法反打'),
  opinion('duplicate', '这个忍者二技能后摇太长，替身后完全无法反打'),
  opinion('empty', ' \t '),
  opinion('punctuation', '!!!'),
  opinion('missing-source', '这个忍者的一技能体验很差', {contentId: 'absent-source'}),
  opinion('creator', '火影手游技能后摇评价', {voiceType: 'creator', sourceType: 'creator_view'}),
  opinion('hard-noise', '666'),
  opinion('triage-skip', '该出全员实战视频了')
];

const configFor = (dataRoot: string): AppConfig => ({
  host: '127.0.0.1', port: 0, dataRoot, browserChannel: 'chrome', browserHeadless: true,
  openBrowser: false, uidSalt: 'count-test-salt', analysisTransport: 'proxy',
  aiModel: 'gpt-6-luna', aiReasoningEffort: 'medium', aiBatchSize: 10, aiConcurrency: 12
});

const resultFor = (opinionId: string) => ({
  opinionId, gameRelevant: true, relevanceScore: 0.95, insightValue: 'strong',
  informationType: 'product_feedback', claimObject: '二技能后摇',
  claim: '二技能后摇太长导致无法反打', specificitySignals: ['mechanism', 'impact'],
  reasonCodes: ['specific_mechanic_issue'],
  topics: [{name: '决斗场体验', sentiment: 'negative', evidence: '二技能后摇太长'}],
  emotion: 'frustration', stance: 'complaint', severity: 4, behaviorIntents: [],
  playerSegment: 'unknown', actionability: 'high', confidence: 0.95, needsReview: false
});

const seedRun = async (store: FileRunStore, mode: 'live' | 'demo') => {
  const manifest = await store.createRun(normalizeResearchRequest({mode, keywords: ['火影手游']}));
  await store.appendContent(manifest.id, source);
  for (const record of records()) await store.appendOpinion(manifest.id, record);
  // Final metadata must come from raw records, rather than these stale collection counters.
  await store.updateManifest(manifest.id, (current) => ({...current,
    counts: {...current.counts, contents: 99, sources: 99, opinions: 999}
  }));
  return manifest;
};

const waitForCompleted = async (manager: RunManager, runId: string) => {
  const deadline = Date.now() + 5_000;
  let acceptManifest!: (manifest: RunManifest) => void;
  let rejectCompletion!: (error: unknown) => void;
  let failure: unknown;
  const completion = new Promise<RunManifest>((resolveComplete, rejectComplete) => {
    rejectCompletion = rejectComplete;
    acceptManifest = (manifest) => {
      if (manifest.id !== runId) return;
      try {
        assert.notEqual(manifest.state, 'failed_recoverable', manifest.error);
      } catch (error) {
        failure = error;
        rejectComplete(error);
        return;
      }
      if (manifest.reportReady && ['completed', 'completed_early'].includes(manifest.state)) resolveComplete(manifest);
    };
  });
  // Subscribe before the initial read so a fast all-cache run cannot complete between them.
  const unsubscribe = manager.subscribe(acceptManifest);
  const timer = setTimeout(() => {
    failure = new Error('Timed out waiting for the final manifest and run-lock release.');
    rejectCompletion(failure);
  }, 5_000);
  void completion.catch(() => undefined);
  try {
    // Progress events already provide every manifest update. Repeated readFile polling would
    // contend with atomic renames on Windows and manufacture failures unrelated to counts.
    acceptManifest(await manager.get(runId));
    const manifest = await completion;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try {
        await stat(join(manager.store.runDirectory(runId), '.active.lock'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        if (failure) throw failure;
        return manifest;
      }
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 40));
    }
    throw new Error('Timed out waiting for run-lock release.');
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
};

const checkFinalCounts = async (
  store: FileRunStore, manifest: RunManifest, expected: {raw: number; processed: number; cached: number}
) => {
  const metadata = manifest.analysis!;
  assert.ok(metadata);
  assert.equal(metadata.processedOpinions, expected.processed);
  assert.equal(metadata.duplicateOpinions, 1);
  assert.equal(metadata.cleaningExcludedOpinions, 2);
  assert.equal(metadata.missingContentOpinions, 1);
  assert.equal(metadata.cachedAiOpinions, expected.cached);
  assert.equal(metadata.processedOpinions! + metadata.duplicateOpinions!
    + metadata.cleaningExcludedOpinions! + metadata.missingContentOpinions!, expected.raw);
  assert.equal(manifest.counts.opinions, expected.raw);
  assert.equal(manifest.counts.contents, 1);
  assert.equal(manifest.counts.sources, 1);
  assert.ok(metadata.cachedAiOpinions! <= metadata.processedOpinions!);

  const [quality, classifications, raw] = await Promise.all([
    store.readQualityReport(manifest.id), store.readClassifications(manifest.id), store.readOpinions(manifest.id)
  ]);
  assert.equal(classifications.length, expected.processed);
  assert.equal(raw.length, expected.raw);
  for (const name of ['processedOpinions', 'duplicateOpinions', 'cleaningExcludedOpinions',
    'missingContentOpinions', 'cachedAiOpinions'] as const) {
    assert.equal(quality[name], metadata[name], `${name} must agree between manifest and quality report`);
  }
  assert.equal(quality.rawOpinions, expected.raw);
  assert.ok(!classifications.some((item) => ['duplicate', 'empty', 'punctuation', 'missing-source'].includes(item.opinionId)));
  assert.equal(raw.find((item) => item.id === 'empty')?.text, ' \t ');
};

const removeTestDirectory = async (directory: string) => {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('naruto-counts-'));
  await rm(target, {recursive: true, force: true});
};

test('finalization reconciles raw records and preserves cache as a subset through full and partial-cache resume', {timeout: 8_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-counts-ai-'));
  const store = new FileRunStore(directory);
  const auth = new ArchtreeAuthService();
  auth.ensureAccess = async () => ({userId: '64b000000000000000000009', email: 'test@example.com', role: 'user'});
  const requests: Array<{kind: string; ids: string[]}> = [];
  auth.request = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {kind: 'triage' | 'detail'; batch: Array<{opinionId: string}>};
    const ids = body.batch.map((item) => item.opinionId);
    requests.push({kind: body.kind, ids});
    assert.ok(ids.every((id) => ['detail', 'triage-skip', 'new-detail'].includes(id)));
    return new Response(JSON.stringify({protocolVersion: 1, kind: body.kind, model: 'gpt-6-luna',
      promptVersion: body.kind === 'triage' ? 'naruto-decisions-v1' : 'naruto-opinion-v4',
      results: ids.map((id) => body.kind === 'detail' ? resultFor(id) : {
        opinionId: id, decision: id === 'triage-skip' ? 'skip' : 'analyze', gameRelevant: true,
        informationType: id === 'triage-skip' ? 'content_request' : 'product_feedback', reasonCode: 'test-triage'
      }), usage: {inputTokens: 100, outputTokens: body.kind === 'triage' ? 0 : 30,
        totalTokens: body.kind === 'triage' ? 100 : 130}}));
  };
  const manager = new RunManager(store, configFor(directory), auth);
  const observed: AiClassificationProgress[] = [];
  const unsubscribe = manager.subscribe((manifest) => {
    if (manifest.progress?.phase === 'analyzing' && manifest.progress.activity) {
      observed.push({completed: manifest.progress.completed!, total: manifest.progress.total!,
        cached: manifest.progress.activity.cached!, activity: manifest.progress.activity});
    }
  });
  try {
    await manager.initialize();
    const created = await seedRun(store, 'live');
    await manager.finalize(created.id);
    const fresh = await waitForCompleted(manager, created.id);
    assert.equal(fresh.state, 'completed_early');
    await checkFinalCounts(store, fresh, {raw: 8, processed: 4, cached: 0});
    assert.equal(fresh.analysis?.creatorViewsExcluded, 1);
    assert.equal(fresh.analysis?.localHardNoise, 1);
    assert.equal(fresh.analysis?.fastTriageSkipped, 1);
    assert.equal(fresh.analysis?.detailedAiOpinions, 1);
    const freshCache = await store.readAiClassificationCache(created.id);
    assert.equal(freshCache.length, 4);
    assert.equal(requests.length, 2);

    // Simulate a recovered investigation with classifications saved before report finalization.
    await store.updateManifest(created.id, (current) => ({...current, state: 'paused',
      stopReason: 'source_exhausted', reportReady: false, progress: {phase: 'analyzing'},
      counts: {...current.counts, opinions: 999}
    }));
    observed.length = 0;
    await manager.resume(created.id);
    const resumed = await waitForCompleted(manager, created.id);
    assert.equal(resumed.state, 'completed');
    await checkFinalCounts(store, resumed, {raw: 8, processed: 4, cached: 4});
    assert.equal(requests.length, 2, 'An all-cache resume must make no provider requests');
    assert.equal((await store.readAiClassificationCache(created.id)).length, 4);
    const cachedActivity = observed.at(-1)!.activity!;
    assert.equal(cachedActivity.cached, 4);
    assert.equal(cachedActivity.localExcluded, 0);
    assert.equal(cachedActivity.triageSkipped, 0);
    assert.equal(cachedActivity.detailed, 0);
    // Final route counts include cached classifications; the live invocation counts cache exclusively.
    assert.equal(resumed.analysis?.detailedAiOpinions, 1);
    assert.equal(resumed.analysis!.creatorViewsExcluded! + resumed.analysis!.localHardNoise!
      + resumed.analysis!.fastTriageSkipped! + resumed.analysis!.detailedAiOpinions!, 4);

    await store.appendOpinion(created.id, opinion('new-detail', '这个忍者二技能后摇太长，所以无法反打'));
    observed.length = 0;
    await manager.reanalyze(created.id);
    const partial = await waitForCompleted(manager, created.id);
    await checkFinalCounts(store, partial, {raw: 9, processed: 5, cached: 4});
    assert.deepEqual(requests.slice(2), [
      {kind: 'triage', ids: ['new-detail']}, {kind: 'detail', ids: ['new-detail']}
    ]);
    assert.equal(partial.analysis?.detailedAiOpinions, 2);
    const partialActivity = observed.at(-1)!.activity!;
    assert.equal(partialActivity.cached, 4);
    assert.equal(partialActivity.detailed, 1);
    assert.equal(partialActivity.localExcluded, 0);
    assert.equal(partialActivity.triageSkipped, 0);
    assert.equal(partialActivity.cached! + partialActivity.detailed, partial.analysis?.processedOpinions);
    const finalCache = await store.readAiClassificationCache(created.id);
    assert.equal(finalCache.length, 5);
    assert.equal(new Set(finalCache.map((item) => item.opinionId)).size, 5);
  } finally {
    unsubscribe();
    await removeTestDirectory(directory);
  }
});

test('collection-to-report completion stores the same raw-count reconciliation', {timeout: 8_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-counts-collection-'));
  const store = new FileRunStore(directory);
  const manager = new RunManager(store, configFor(directory));
  try {
    await manager.initialize();
    const created = await seedRun(store, 'demo');
    const checkpoint = await store.readCheckpoint(created.id);
    await store.writeCheckpoint(created.id, {...checkpoint, pendingCandidates: [],
      seenContentIds: [source.id], seenOpinionIds: records().map((item) => item.id)
    });
    await store.updateManifest(created.id, (current) => ({...current, state: 'paused',
      progress: {phase: 'collecting'}
    }));
    await manager.resume(created.id);
    const completed = await waitForCompleted(manager, created.id);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.stopReason, 'source_exhausted');
    assert.equal(completed.analysis?.mode, 'rule_demo');
    await checkFinalCounts(store, completed, {raw: 8, processed: 4, cached: 0});
    assert.equal((await store.readAiClassificationCache(created.id)).length, 0);
  } finally {
    await removeTestDirectory(directory);
  }
});
