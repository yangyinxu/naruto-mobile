import {beforeEach, describe, expect, it, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {createHash, webcrypto} from 'node:crypto';
import {zipSync, strToU8} from 'fflate';
import {AiClassifier} from '../../../src/processing/aiClassifier';
import type {ContentRecord, OpinionRecord, RunManifest} from '../../../src/domain/types';
import {BrowserRunStore} from './store';
import {BrowserRunLocks} from './locks';
import {BrowserResearchRuntime} from './runtime';
import {BrowserAnalysisSession} from './auth';
import {ChromeExtensionBridge} from './bridge';
import {decodeRunArchive, encodeRunArchive} from './archive';
import type {BrowserRun, ExtensionBridge, ExtensionEvent} from './types';

const timestamp = '2026-10-13T00:00:00.000Z';
const runId = '20261013T000000-12345678';
const content: ContentRecord = {id: 'BVAI001', runId, type: 'video', url: 'https://www.bilibili.com/video/BVAI001',
  title: '火影忍者手游新忍者实战测评', description: '测试新忍者技能后摇和决斗场表现。',
  discoveryKeyword: '火影忍者手游', discoveryRank: 1, collectedAt: timestamp, metrics: {views: 100}};
const opinion: OpinionRecord = {id: 'root-opinion', runId, contentId: content.id, contentType: 'video', sourceType: 'comment',
  voiceType: 'viewer', text: '这个忍者二技能后摇太长，替身后完全无法反打', collectedAt: timestamp, authorUid: '123456',
  authorName: '私有作者名称', authorProfileUrl: 'https://space.bilibili.com/123456', authorHash: 'private-author-hash',
  sourceRecordId: 'r1', likes: 20, replies: 1, sourceUrl: content.url};
const manifest = (state: RunManifest['state'] = 'paused'): RunManifest => ({schemaVersion: 1, id: runId, state,
  request: {name: '本机调查', durationMinutes: 5, contentWindowDays: 30, keywords: ['火影忍者手游'], includeVideos: true,
    includeArticles: true, mode: 'live', browserVisible: true, browserWindowCount: 4, maxSources: 20},
  createdAt: timestamp, updatedAt: timestamp, activeElapsedMs: 1000, statusMessage: '已暂停', reportReady: false,
  counts: {candidates: 1, contents: 1, opinions: 1, validOpinions: 0, sources: 1, warnings: 0}});
const snapshot = (state: RunManifest['state'] = 'paused'): BrowserRun => ({id: runId, manifest: manifest(state),
  checkpoint: {schemaVersion: 1, pendingCandidates: [content], seenContentIds: [], seenOpinionIds: [opinion.id],
    activeElapsedMs: 1000, updatedAt: timestamp}, candidates: [content], contents: [content], opinions: [opinion],
  processedOpinions: [], classifications: [], aiClassifications: [], cache: [], events: []});

const detail = (opinionId: string) => ({opinionId, gameRelevant: true, relevanceScore: 0.96, insightValue: 'strong',
  informationType: 'product_feedback', claimObject: '二技能后摇', claim: '二技能后摇过长导致替身后无法反打',
  specificitySignals: ['mechanism', 'impact'], reasonCodes: ['specific_mechanic_issue'], topics: [{name: '决斗场体验',
    sentiment: 'negative', evidence: opinion.text}], emotion: 'frustration', stance: 'complaint', severity: 4,
  behaviorIntents: [], playerSegment: 'unknown', actionability: 'high', confidence: 0.93, needsReview: false});
const proxyResponse = (body: {kind: 'triage' | 'detail'; batch: Array<{opinionId: string}>}) => new Response(JSON.stringify({
  protocolVersion: 1, kind: body.kind, promptVersion: body.kind === 'triage' ? 'naruto-decisions-v1' : 'naruto-opinion-v4',
  model: 'gpt-6-luna', results: body.batch.map(({opinionId}) => body.kind === 'triage'
    ? {opinionId, decision: 'analyze', gameRelevant: true, informationType: 'product_feedback', reasonCode: 'possible_product_feedback'}
    : detail(opinionId)), usage: {inputTokens: 100, cachedInputTokens: 20, outputTokens: body.kind === 'triage' ? 0 : 30,
    reasoningTokens: body.kind === 'triage' ? 0 : 5, totalTokens: body.kind === 'triage' ? 100 : 130}
}), {headers: {'content-type': 'application/json', 'X-Finitude-Account-Viewer': 'account-A'}});

class FakeBridge implements ExtensionBridge {
  readonly calls: Array<{method: string; payload?: unknown}> = [];
  commentReadiness: unknown = 1;
  isolatedCollectionWindow: unknown = 1;
  contentWindowEnforced: unknown = 1;
  private listeners = new Set<(event: ExtensionEvent) => void>();
  async request<T>(method: string, payload?: unknown) {
    this.calls.push({method, payload});
    return (method === 'status' ? {connected: true, loginState: 'logged_in', commentReadiness: this.commentReadiness,
      isolatedCollectionWindow: this.isolatedCollectionWindow, contentWindowEnforced: this.contentWindowEnforced} : {accepted: true}) as T;
  }
  subscribe(listener: (event: ExtensionEvent) => void) {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}
  send(type: ExtensionEvent['type'], payload: unknown, id = runId) {
    for (const listener of this.listeners) listener({channel: 'naruto-extension-v1', direction: 'event', runId: id, type, payload});
  }
}
const lockManager = () => {
  const held = new Set<string>();
  return {request: async (name: string, _options: unknown, operation: (lock: unknown) => Promise<void>) => {
    if (held.has(name)) return operation(null);
    held.add(name);
    try {return await operation({name});} finally {held.delete(name);}
  }} as unknown as LockManager;
};
const service = (onClassification?: (body: {kind: 'triage' | 'detail'; batch: Array<{opinionId: string}>}, init: RequestInit) => Promise<Response>) => {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === '/naruto/api/v1/status') return Response.json({enabled: true, protocolVersion: 1,
      model: 'gpt-6-luna', maxConcurrentRequests: 12});
    if (String(input) === '/auth/browser/session') return Response.json({user: {id: 'account-A', email: 'account@example.com', role: 'user'}},
      {headers: {'X-Finitude-Account-Viewer': 'account-A'}});
    if (String(input) === '/naruto/api/v1/classify') {
      const body = JSON.parse(String(init?.body));
      return onClassification ? onClassification(body, init!) : proxyResponse(body);
    }
    throw new Error('unexpected network request');
  });
  return {fetchImpl, session: new BrowserAnalysisSession(fetchImpl as typeof fetch)};
};
const until = async (condition: () => Promise<boolean>) => {
  await vi.waitFor(async () => expect(await condition()).toBe(true), {timeout: 3000, interval: 10});
};

beforeEach(() => {vi.stubGlobal('crypto', webcrypto);});

describe('browser local persistence and cross-tab lifecycle', () => {
  it.each(['paused', 'completed', 'completed_early', 'failed_recoverable'] as const)('deletes a settled %s snapshot', async (state) => {
    const store = new BrowserRunStore(`delete-${state}`, new IDBFactory());
    const run = snapshot(state);
    run.report = '<html>saved report</html>';
    await store.create(run);
    const runtime = new BrowserResearchRuntime(store, new FakeBridge(), service().session, new BrowserRunLocks(lockManager()));
    await runtime.delete(runId);
    expect(await runtime.list()).toEqual([]);
    await expect(runtime.get(runId)).rejects.toThrow('本机没有这份调查');
    await expect(store.get(runId)).rejects.toThrow('本机没有这份调查');
  });

  it.each(['created', 'discovering', 'collecting', 'pause_requested', 'processing'] as const)('checks the persisted %s state under the deletion lock', async (state) => {
    const store = new BrowserRunStore(`delete-active-${state}`, new IDBFactory()), locks = new BrowserRunLocks(lockManager());
    await store.create(snapshot());
    const runtime = new BrowserResearchRuntime(store, new FakeBridge(), service().session, locks);
    await runtime.initialize();
    // A state change after initialization must not be treated as a settled historical record.
    await store.update(runId, (run) => {run.manifest.state = state; return run;});
    await expect(runtime.delete(runId)).rejects.toThrow('等待分析完成后删除');
    expect((await store.get(runId)).manifest.state).toBe(state);
    const release = await locks.acquire(runId);
    release();
  });

  it('refuses to delete an active job in the same page until collection finishes pausing', async () => {
    const store = new BrowserRunStore('delete-same-page-active', new IDBFactory()), bridge = new FakeBridge();
    await store.create(snapshot());
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    await expect(runtime.delete(runId)).rejects.toThrow('该调查正在运行');
    expect((await store.get(runId)).opinions).toEqual([opinion]);
    bridge.send('complete', {outcome: 'paused', checkpoint: snapshot().checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
    await runtime.delete(runId);
    expect(await store.list()).toEqual([]);
  });

  it('refuses deletion under another page lease and permits it after the lease is released', async () => {
    const store = new BrowserRunStore('delete-other-page', new IDBFactory()), manager = lockManager();
    await store.create(snapshot());
    const runtime = new BrowserResearchRuntime(store, new FakeBridge(), service().session, new BrowserRunLocks(manager));
    const release = await new BrowserRunLocks(manager).acquire(runId);
    await expect(runtime.delete(runId)).rejects.toThrow('另一个页面');
    expect((await store.get(runId)).opinions).toEqual([opinion]);
    release();
    await Promise.resolve();
    await runtime.delete(runId);
    expect(await store.list()).toEqual([]);
  });

  it('releases the deletion lease after missing data or a write failure so deletion can be retried', async () => {
    const store = new BrowserRunStore('delete-retry', new IDBFactory()), locks = new BrowserRunLocks(lockManager());
    const runtime = new BrowserResearchRuntime(store, new FakeBridge(), service().session, locks);
    await expect(runtime.delete(runId)).rejects.toThrow('本机没有这份调查');
    await store.create(snapshot());
    vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('磁盘写入失败'));
    await expect(runtime.delete(runId)).rejects.toThrow('磁盘写入失败');
    expect((await store.get(runId)).opinions).toEqual([opinion]);
    await runtime.delete(runId);
    expect(await store.list()).toEqual([]);
  });

  it('clears cached recovery failures in this page and another page after durable deletion', async () => {
    class FakeBroadcastChannel {
      static channels: FakeBroadcastChannel[] = [];
      onmessage?: (event: MessageEvent) => void;
      constructor(_name: string) {FakeBroadcastChannel.channels.push(this);}
      postMessage(data: unknown) {
        for (const channel of FakeBroadcastChannel.channels) {
          if (channel !== this) channel.onmessage?.({data} as MessageEvent);
        }
      }
    }
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    try {
      const store = new BrowserRunStore('delete-recovery-cache', new IDBFactory()), manager = lockManager();
      await store.create(snapshot('processing'));
      vi.spyOn(store, 'update').mockRejectedValue(new Error('存储空间不足'));
      const createRuntime = () => new BrowserResearchRuntime(store, new FakeBridge(), service().session,
        new BrowserRunLocks(manager), window);
      const first = createRuntime(), second = createRuntime();
      await first.initialize();
      await second.initialize();
      expect((await first.get(runId)).state).toBe('failed_recoverable');
      expect((await second.get(runId)).state).toBe('failed_recoverable');
      await first.delete(runId);
      await expect(first.get(runId)).rejects.toThrow('本机没有这份调查');
      await expect(second.get(runId)).rejects.toThrow('本机没有这份调查');
      expect(await store.list()).toEqual([]);
    } finally {vi.unstubAllGlobals();}
  });

  it('requires window isolation before creating live work with an older installed extension', async () => {
    for (const capability of [undefined, null, 0, 2, '1']) {
      const store = new BrowserRunStore(`old-window-start-${String(capability)}`, new IDBFactory()), bridge = new FakeBridge();
      bridge.isolatedCollectionWindow = capability;
      const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
      await expect(runtime.start(manifest().request)).rejects.toThrow('请更新至 0.1.7');
      expect(await store.list()).toEqual([]);
      expect(bridge.calls.some((call) => call.method === 'start')).toBe(false);
    }
  });

  it('requires the content-window collector before creating live work', async () => {
    const store = new BrowserRunStore('old-content-window-start', new IDBFactory()), bridge = new FakeBridge();
    bridge.contentWindowEnforced = undefined;
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await expect(runtime.start(manifest().request)).rejects.toThrow('请更新至 0.1.9');
    expect(await store.list()).toEqual([]);
    expect(bridge.calls.some((call) => call.method === 'start')).toBe(false);
  });

  it('leaves a paused checkpoint intact until an isolated-window collector is available', async () => {
    const store = new BrowserRunStore('old-window-resume', new IDBFactory()), bridge = new FakeBridge();
    bridge.isolatedCollectionWindow = undefined;
    const run = snapshot(), original = structuredClone(run);
    await store.create(run);
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await expect(runtime.resume(runId)).rejects.toThrow('请更新至 0.1.7');
    expect((await store.get(runId)).checkpoint).toEqual(original.checkpoint);
    expect((await store.get(runId)).opinions).toEqual(original.opinions);
    expect((await store.get(runId)).events.some((event) => event.type === 'comment_readiness_v1')).toBe(false);
    expect((await store.get(runId)).events.at(-1)?.type).toBe('run_interrupted');
    expect(bridge.calls.some((call) => call.method === 'resume')).toBe(false);
    bridge.isolatedCollectionWindow = 1;
    await runtime.resume(runId);
    const payload = bridge.calls.find((call) => call.method === 'resume')!.payload as {checkpoint: BrowserRun['checkpoint']};
    bridge.send('complete', {outcome: 'paused', checkpoint: payload.checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
  });

  it('requires the comment readiness capability before creating any live run', async () => {
    for (const capability of [undefined, null, 0, 2, '1']) {
      const store = new BrowserRunStore(`old-extension-start-${String(capability)}`, new IDBFactory()), bridge = new FakeBridge();
      bridge.commentReadiness = capability;
      const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
      await expect(runtime.start(manifest().request)).rejects.toThrow('请更新至 0.1.2');
      expect(await store.list()).toEqual([]);
      expect(bridge.calls.some((call) => call.method === 'start')).toBe(false);
    }
  });

  it('requires an updated worker before repairing an existing checkpoint and safely retries after an upgrade', async () => {
    const store = new BrowserRunStore('old-extension-resume', new IDBFactory()), bridge = new FakeBridge();
    bridge.commentReadiness = undefined;
    const run = snapshot();
    run.opinions = [{...opinion, id: 'old-creator', voiceType: 'creator', sourceType: 'creator_view', text: content.title}];
    run.checkpoint = {...run.checkpoint, pendingCandidates: [], seenContentIds: [content.id], seenOpinionIds: ['old-creator']};
    const original = structuredClone(run);
    await store.create(run);
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await expect(runtime.resume(runId)).rejects.toThrow('请更新至 0.1.2');
    const rejected = await store.get(runId);
    expect(rejected.checkpoint).toEqual(original.checkpoint); expect(rejected.contents).toEqual(original.contents);
    expect(rejected.opinions).toEqual(original.opinions);
    expect(rejected.events.some((event) => event.type === 'comment_readiness_v1')).toBe(false);
    expect(bridge.calls.some((call) => call.method === 'resume')).toBe(false);
    bridge.commentReadiness = 1;
    await runtime.resume(runId);
    const payload = bridge.calls.find((call) => call.method === 'resume')!.payload as {checkpoint: BrowserRun['checkpoint']};
    expect(payload.checkpoint.pendingCandidates.map((candidate) => candidate.id)).toEqual([content.id]);
    expect(payload.checkpoint.seenContentIds).toEqual([]);
    expect(payload.checkpoint.seenOpinionIds).toEqual(original.checkpoint.seenOpinionIds);
    expect((await store.get(runId)).events.filter((event) => event.type === 'comment_readiness_v1')).toHaveLength(1);
    bridge.send('complete', {outcome: 'paused', checkpoint: payload.checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
  });

  it('repairs legacy title-only checkpoints once on explicit resume without losing raw evidence or pending work', async () => {
    const store = new BrowserRunStore('legacy-comment-readiness', new IDBFactory()), bridge = new FakeBridge();
    const run = snapshot(), pending = {...content, id: 'BVPENDING', url: 'https://www.bilibili.com/video/BVPENDING', discoveryRank: 3};
    const withComments = {...content, id: 'BVREADABLE', url: 'https://www.bilibili.com/video/BVREADABLE', discoveryRank: 2};
    const creator: OpinionRecord = {...opinion, id: 'old-creator', voiceType: 'creator', sourceType: 'creator_view', text: content.title};
    const savedComment: OpinionRecord = {...opinion, id: 'saved-viewer', contentId: withComments.id, sourceUrl: withComments.url};
    run.candidates[0] = {...content, title: '搜索页截断的旧标题',
      discoveryUrl: 'https://search.bilibili.com/video?keyword=test', popularityText: '1000 views'};
    run.contents.push(withComments); run.candidates.push(withComments, pending); run.opinions = [creator, savedComment];
    run.checkpoint = {...run.checkpoint, pendingCandidates: [pending], seenContentIds: [content.id, withComments.id],
      seenOpinionIds: [creator.id, savedComment.id]};
    const original = structuredClone(run);
    await store.create(run);
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await runtime.initialize();
    expect((await store.get(runId)).checkpoint).toEqual(original.checkpoint);
    await runtime.resume(runId);
    const firstPayload = bridge.calls.find((call) => call.method === 'resume')!.payload as {checkpoint: BrowserRun['checkpoint']};
    expect(firstPayload.checkpoint.pendingCandidates.map((candidate) => candidate.id)).toEqual([content.id, pending.id]);
    expect(firstPayload.checkpoint.pendingCandidates[0]).toEqual({...original.candidates[0], title: content.title});
    expect(firstPayload.checkpoint.seenContentIds).toEqual([withComments.id]);
    expect(firstPayload.checkpoint.seenOpinionIds).toEqual(original.checkpoint.seenOpinionIds);
    expect(firstPayload.checkpoint.activeElapsedMs).toBe(original.checkpoint.activeElapsedMs);
    const repaired = await store.get(runId);
    expect(repaired.contents).toEqual(original.contents); expect(repaired.opinions).toEqual(original.opinions);
    expect(repaired.candidates).toEqual(original.candidates);
    expect(repaired.events.filter((event) => event.type === 'comment_readiness_v1')).toHaveLength(1);
    // The marker also survives the desktop-compatible backup boundary.
    const backup = {...repaired, manifest: {...repaired.manifest, state: 'paused' as const}};
    expect(decodeRunArchive(encodeRunArchive(backup)).events.filter((event) => event.type === 'comment_readiness_v1')).toHaveLength(1);
    bridge.send('complete', {outcome: 'paused', checkpoint: firstPayload.checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
    await runtime.resume(runId);
    const resumedPayload = bridge.calls.filter((call) => call.method === 'resume').at(-1)!.payload as {checkpoint: BrowserRun['checkpoint']};
    expect(resumedPayload.checkpoint.pendingCandidates.map((candidate) => candidate.id)).toEqual([content.id, pending.id]);
    expect((await store.get(runId)).events.filter((event) => event.type === 'comment_readiness_v1')).toHaveLength(1);
    bridge.send('content', {...content, collectedAt: '2026-10-13T01:00:00.000Z'});
    bridge.send('opinion', creator);
    bridge.send('opinion', {...opinion, id: 'retried-viewer'});
    const collectedCheckpoint = {...resumedPayload.checkpoint, pendingCandidates: [pending],
      seenContentIds: [withComments.id, content.id], seenOpinionIds: [...resumedPayload.checkpoint.seenOpinionIds, 'retried-viewer']};
    bridge.send('complete', {outcome: 'paused', checkpoint: collectedCheckpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
    expect((await store.get(runId)).contents).toEqual(original.contents);
    expect((await store.get(runId)).opinions.map((item) => item.id)).toEqual([creator.id, savedComment.id, 'retried-viewer']);
    await runtime.resume(runId);
    const completedPayload = bridge.calls.filter((call) => call.method === 'resume').at(-1)!.payload as {checkpoint: BrowserRun['checkpoint']};
    expect(completedPayload.checkpoint.pendingCandidates.map((candidate) => candidate.id)).toEqual([pending.id]);
    expect(completedPayload.checkpoint.seenContentIds).toEqual([withComments.id, content.id]);
    bridge.send('complete', {outcome: 'paused', checkpoint: completedPayload.checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
  });

  it('marks new runs so explicitly empty sources are not requeued during later resumes', async () => {
    const store = new BrowserRunStore('new-comment-readiness', new IDBFactory()), bridge = new FakeBridge();
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    const started = await runtime.start(manifest().request), id = started.id;
    const creator: OpinionRecord = {...opinion, id: 'empty-creator', runId: id, voiceType: 'creator', sourceType: 'creator_view', text: content.title};
    bridge.send('content', {...content, runId: id}, id); bridge.send('opinion', creator, id);
    const checkpoint = {...snapshot().checkpoint, pendingCandidates: [], seenContentIds: [content.id], seenOpinionIds: [creator.id]};
    bridge.send('complete', {outcome: 'paused', checkpoint}, id);
    await until(async () => (await runtime.get(id)).state === 'paused');
    expect((await store.get(id)).events.filter((event) => event.type === 'comment_readiness_v1')).toHaveLength(1);
    await runtime.resume(id);
    const payload = bridge.calls.filter((call) => call.method === 'resume').at(-1)!.payload as {checkpoint: BrowserRun['checkpoint']};
    expect(payload.checkpoint.pendingCandidates).toEqual([]); expect(payload.checkpoint.seenContentIds).toEqual([content.id]);
    expect((await store.get(id)).opinions.map((item) => item.id)).toEqual([creator.id]);
    bridge.send('complete', {outcome: 'paused', checkpoint: payload.checkpoint}, id);
    await until(async () => (await runtime.get(id)).state === 'paused');
  });

  it('leaves title-only records alone when resume is recovering finalized analysis', async () => {
    const store = new BrowserRunStore('finalized-comment-readiness', new IDBFactory()), bridge = new FakeBridge();
    const run = snapshot(); run.manifest.stopReason = 'user_finalized';
    run.opinions = [{...opinion, id: 'finalized-creator', voiceType: 'creator', sourceType: 'creator_view', text: content.title}];
    run.checkpoint = {...run.checkpoint, pendingCandidates: [], seenContentIds: [content.id], seenOpinionIds: ['finalized-creator']};
    const originalCheckpoint = structuredClone(run.checkpoint);
    await store.create(run);
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    await until(async () => (await runtime.get(runId)).reportReady);
    expect(bridge.calls.some((call) => call.method === 'resume')).toBe(false);
    expect((await store.get(runId)).checkpoint).toEqual(originalCheckpoint);
    expect((await store.get(runId)).events.some((event) => event.type === 'comment_readiness_v1')).toBe(false);
  });

  it('does not launch or commit a partial legacy repair when the atomic store update fails', async () => {
    const store = new BrowserRunStore('legacy-comment-readiness-quota', new IDBFactory()), bridge = new FakeBridge();
    const run = snapshot();
    run.opinions = [{...opinion, id: 'old-creator', voiceType: 'creator', sourceType: 'creator_view', text: content.title}];
    run.checkpoint = {...run.checkpoint, pendingCandidates: [], seenContentIds: [content.id], seenOpinionIds: ['old-creator']};
    const original = structuredClone(run);
    await store.create(run);
    vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('本机存储空间不足'));
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await expect(runtime.resume(runId)).rejects.toThrow('本机存储空间不足');
    const failed = await store.get(runId);
    expect(failed.checkpoint).toEqual(original.checkpoint); expect(failed.contents).toEqual(original.contents);
    expect(failed.opinions).toEqual(original.opinions);
    expect(failed.events.some((event) => event.type === 'comment_readiness_v1')).toBe(false);
    expect(bridge.calls.some((call) => call.method === 'resume')).toBe(false);
    await runtime.resume(runId);
    const payload = bridge.calls.find((call) => call.method === 'resume')!.payload as {checkpoint: BrowserRun['checkpoint']};
    expect(payload.checkpoint.pendingCandidates.map((candidate) => candidate.id)).toEqual([content.id]);
    expect(payload.checkpoint.seenContentIds).toEqual([]);
    bridge.send('complete', {outcome: 'paused', checkpoint: payload.checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
  });

  it('merges resumed discovery without losing prior sources or duplicating candidates', async () => {
    const store = new BrowserRunStore('resumed-discovery', new IDBFactory()), bridge = new FakeBridge();
    await store.create(snapshot());
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    const dynamic = {id: '123456789', type: 'dynamic', url: 'https://www.bilibili.com/opus/123456789',
      title: '火影手游动态反馈', discoveryKeyword: '火影忍者手游', discoveryRank: 2};
    bridge.send('candidates', [dynamic, dynamic]);
    await until(async () => (await runtime.get(runId)).counts.candidates === 2);
    expect((await store.get(runId)).candidates.map(candidate => candidate.id)).toEqual([content.id, dynamic.id]);
    expect((await store.get(runId)).contents).toHaveLength(1);
    bridge.send('complete', {outcome: 'paused', checkpoint: snapshot().checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
  });
  it('commits snapshots atomically and leaves the previous raw records intact when a write aborts', async () => {
    const store = new BrowserRunStore('atomic', new IDBFactory());
    await store.create(snapshot());
    await expect(store.update(runId, (run) => {run.opinions.push({...opinion, id: 'unsaved'}); throw new Error('disk failure');}))
      .rejects.toThrow('disk failure');
    expect((await store.get(runId)).opinions.map((item) => item.id)).toEqual([opinion.id]);
  });

  it('refuses a second tab, then recovers interrupted collection after the first lease disappears', async () => {
    const manager = lockManager(), locks = new BrowserRunLocks(manager);
    const release = await locks.acquire(runId);
    await expect(new BrowserRunLocks(manager).acquire(runId)).rejects.toThrow('另一个页面');
    const store = new BrowserRunStore('recovery', new IDBFactory());
    await store.create(snapshot('collecting'));
    const blocked = new BrowserResearchRuntime(store, new FakeBridge(), service().session, new BrowserRunLocks(manager));
    await blocked.initialize();
    expect((await store.get(runId)).manifest.state).toBe('collecting');
    release();
    await Promise.resolve();
    const reopened = new BrowserResearchRuntime(store, new FakeBridge(), service().session, new BrowserRunLocks(manager));
    await reopened.initialize();
    expect((await reopened.get(runId)).state).toBe('paused');
    expect((await store.get(runId)).checkpoint.seenOpinionIds).toEqual([opinion.id]);
  });

  it('fails closed when safe cross-tab locking is unavailable', async () => {
    await expect(new BrowserRunLocks(undefined).acquire(runId)).rejects.toThrow('跨页面');
  });

  it('keeps backups readable if recovering a closed active run hits a storage failure', async () => {
    const store = new BrowserRunStore('recovery-quota', new IDBFactory());
    await store.create(snapshot('processing'));
    vi.spyOn(store, 'update').mockRejectedValue(new Error('存储空间不足'));
    const runtime = new BrowserResearchRuntime(store, new FakeBridge(), service().session, new BrowserRunLocks(lockManager()));
    await runtime.initialize();
    expect((await runtime.list())[0].state).toBe('failed_recoverable');
    const raw = await store.get(runId); raw.manifest = await runtime.get(runId);
    expect(decodeRunArchive(encodeRunArchive(raw)).opinions).toHaveLength(1);
    expect((await store.get(runId)).manifest.state).toBe('processing');
  });

  it('pauses on failed storage, retains the last durable checkpoint, and resumes without duplicate raw records', async () => {
    const store = new BrowserRunStore('quota', new IDBFactory()), bridge = new FakeBridge();
    await store.create(snapshot());
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    const originalUpdate = store.update.bind(store);
    vi.spyOn(store, 'update').mockRejectedValue(new Error('本机存储空间不足'));
    bridge.send('opinion', {...opinion, id: 'new-opinion'});
    await until(async () => (await runtime.get(runId)).state === 'failed_recoverable');
    expect(bridge.calls.some((item) => item.method === 'pause')).toBe(true);
    expect((await store.get(runId)).opinions).toHaveLength(1);
    expect((await store.get(runId)).checkpoint.seenOpinionIds).toEqual([opinion.id]);
    vi.mocked(store.update).mockImplementation(originalUpdate);
    await runtime.resume(runId);
    bridge.send('content', content);
    bridge.send('opinion', opinion);
    bridge.send('complete', {outcome: 'paused', checkpoint: snapshot().checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
    expect((await store.get(runId)).contents).toHaveLength(1);
    expect((await store.get(runId)).opinions).toHaveLength(1);
  });

  it('rejects checkpoint claims about unsaved opinions and ignores late extension completion after failure', async () => {
    const store = new BrowserRunStore('unsafe-checkpoint', new IDBFactory()), bridge = new FakeBridge();
    await store.create(snapshot());
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    bridge.send('checkpoint', {...snapshot().checkpoint, seenOpinionIds: ['never-saved']});
    await until(async () => (await runtime.get(runId)).state === 'failed_recoverable');
    bridge.send('complete', {outcome: 'source_exhausted', checkpoint: snapshot().checkpoint});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await runtime.get(runId)).state).toBe('failed_recoverable');
    expect((await store.get(runId)).checkpoint.seenOpinionIds).toEqual([opinion.id]);
  });

  it('extends collection by safely pausing and resuming the extension with the new budget', async () => {
    const store = new BrowserRunStore('extend', new IDBFactory()), bridge = new FakeBridge();
    await store.create(snapshot());
    const runtime = new BrowserResearchRuntime(store, bridge, service().session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    await runtime.extend(runId, 2);
    expect(bridge.calls.at(-1)?.method).toBe('pause');
    bridge.send('complete', {outcome: 'paused', checkpoint: snapshot().checkpoint});
    await until(async () => bridge.calls.filter((item) => item.method === 'resume').length === 2);
    const payload = bridge.calls.at(-1)?.payload as {manifest: RunManifest};
    expect(payload.manifest.request.durationMinutes).toBe(7);
    await runtime.pause(runId);
    bridge.send('complete', {outcome: 'paused', checkpoint: snapshot().checkpoint});
    await until(async () => (await runtime.get(runId)).state === 'paused');
  });

  it('reuses durably saved classifications during reanalysis and preserves the cache in portable archives', async () => {
    const store = new BrowserRunStore('retry-cache', new IDBFactory()), bridge = new FakeBridge();
    const data = snapshot(); data.manifest.stopReason = 'user_finalized'; data.manifest.progress = {phase: 'analyzing'};
    await store.create(data);
    const proxy = service(), runtime = new BrowserResearchRuntime(store, bridge, proxy.session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    await until(async () => (await runtime.get(runId)).reportReady);
    expect((await store.get(runId)).cache).toHaveLength(1);
    const networkCount = proxy.fetchImpl.mock.calls.filter(([path]) => String(path).endsWith('/classify')).length;
    await runtime.reanalyze(runId);
    await until(async () => (await runtime.get(runId)).reportReady);
    expect(proxy.fetchImpl.mock.calls.filter(([path]) => String(path).endsWith('/classify'))).toHaveLength(networkCount);
    expect((await runtime.get(runId)).analysis?.cachedAiOpinions).toBe(1);
    const imported = decodeRunArchive(encodeRunArchive(await store.get(runId)), '20261013T000001-87654321');
    expect(imported.cache[0].inputHash).toBe((await store.get(runId)).cache[0].inputHash);
    expect(imported.manifest.analysis?.usage?.totalTokens).toBe(0);
    expect(imported.report).toContain('调查报告');
  });

  it('retains a successful detail batch when a later batch fails, then analyzes only the missing records on resume', async () => {
    const store = new BrowserRunStore('partial-analysis', new IDBFactory()), bridge = new FakeBridge(), data = snapshot();
    data.manifest.stopReason = 'user_finalized'; data.manifest.progress = {phase: 'analyzing'};
    data.opinions = Array.from({length: 11}, (_, index) => ({...opinion, id: `opinion-${index}`, authorUid: `author-${index}`,
      text: `记录${index}：${opinion.text}`}));
    await store.create(data);
    let failLast = true;
    const proxy = service(async (body) => {
      if (failLast && body.kind === 'detail' && body.batch.length === 1) {
        await until(async () => (await store.get(runId)).cache.length === 10);
        return Response.json({message: '分析暂时中断'}, {status: 400});
      }
      return proxyResponse(body);
    });
    const runtime = new BrowserResearchRuntime(store, bridge, proxy.session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    await until(async () => (await runtime.get(runId)).state === 'failed_recoverable');
    expect((await store.get(runId)).cache).toHaveLength(10);
    expect((await store.get(runId)).opinions).toHaveLength(11);
    failLast = false;
    const before = proxy.fetchImpl.mock.calls.length;
    await runtime.resume(runId);
    await until(async () => (await runtime.get(runId)).reportReady);
    expect((await runtime.get(runId)).analysis?.cachedAiOpinions).toBe(10);
    const retried = proxy.fetchImpl.mock.calls.slice(before).filter(([path]) => String(path).endsWith('/classify'));
    expect(retried).toHaveLength(2);
    expect(retried.map(([, init]) => JSON.parse(String(init?.body)).batch.length)).toEqual([1, 1]);
  });

  it('pauses in-flight analysis without losing raw data and resumes it from the saved phase', async () => {
    const store = new BrowserRunStore('pause-analysis', new IDBFactory()), bridge = new FakeBridge(), data = snapshot();
    data.manifest.stopReason = 'user_finalized'; data.manifest.progress = {phase: 'analyzing'};
    await store.create(data);
    let hold = true, started = false;
    const proxy = service(async (body, init) => {
      if (body.kind === 'detail' && hold) {
        started = true;
        return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('paused', 'AbortError')), {once: true}));
      }
      return proxyResponse(body);
    });
    const runtime = new BrowserResearchRuntime(store, bridge, proxy.session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    await until(async () => started);
    await runtime.pause(runId);
    await until(async () => (await runtime.get(runId)).state === 'paused');
    expect((await store.get(runId)).opinions).toHaveLength(1);
    expect((await runtime.get(runId)).error).toBeUndefined();
    hold = false;
    await runtime.resume(runId);
    await until(async () => (await runtime.get(runId)).reportReady);
    expect((await runtime.get(runId)).state).toBe('completed_early');
  });

  it('preserves classifications while analysis pauses, then deletes the paused investigation with its saved cache and report', async () => {
    const store = new BrowserRunStore('pause-transport-retry', new IDBFactory()), data = snapshot();
    data.manifest.stopReason = 'user_finalized'; data.manifest.progress = {phase: 'analyzing'};
    await store.create(data);
    let interrupt = false;
    const proxy = service(async (body) => {
      if (interrupt && body.kind === 'detail') throw new TypeError('Failed to fetch');
      return proxyResponse(body);
    });
    const runtime = new BrowserResearchRuntime(store, new FakeBridge(), proxy.session, new BrowserRunLocks(lockManager()));
    await runtime.resume(runId);
    await until(async () => (await runtime.get(runId)).reportReady);
    const savedCache = (await store.get(runId)).cache;
    expect(savedCache).toHaveLength(1);
    await store.update(runId, (run) => {
      run.opinions.push({...opinion, id: 'pending-opinion', authorUid: 'pending-author',
        text: '这个忍者奥义结束之后有很长硬直，对手可以直接反打'});
      return run;
    });
    interrupt = true;
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
    try {
      // IndexedDB transactions yield to real task scheduling without advancing the retry clock.
      const untilSaved = async (condition: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 500; attempt += 1) if (await condition()) return;
        throw new Error('Expected browser analysis state was not saved');
      };
      await runtime.reanalyze(runId);
      await untilSaved(async () => (await runtime.get(runId)).progress?.activity?.retryingRequests === 1);
      const requests = proxy.fetchImpl.mock.calls.filter(([path]) => String(path).endsWith('/classify')).length;
      await runtime.pause(runId);
      await vi.advanceTimersByTimeAsync(1000);
      await untilSaved(async () => (await runtime.get(runId)).state === 'paused');
      await vi.advanceTimersByTimeAsync(60_000);
      const paused = await store.get(runId);
      expect(paused.manifest.error).toBeUndefined();
      expect(paused.manifest.reportReady).toBe(false);
      expect(paused.opinions).toHaveLength(2);
      expect(paused.cache).toEqual(savedCache);
      expect(paused.report).toContain('调查报告');
      expect(proxy.fetchImpl.mock.calls.filter(([path]) => String(path).endsWith('/classify'))).toHaveLength(requests);
    } finally {vi.useRealTimers();}
    await runtime.delete(runId);
    expect(await runtime.list()).toEqual([]);
    await expect(store.get(runId)).rejects.toThrow('本机没有这份调查');
  });

  it('supports a fully local demonstration without signing in or contacting the extension', async () => {
    const store = new BrowserRunStore('demo', new IDBFactory()), bridge = new FakeBridge(), proxy = service();
    const runtime = new BrowserResearchRuntime(store, bridge, proxy.session, new BrowserRunLocks(lockManager()));
    const run = await runtime.start({...manifest().request, mode: 'demo'});
    await until(async () => (await runtime.get(run.id)).reportReady);
    expect((await runtime.get(run.id)).analysis?.mode).toBe('rule_demo');
    expect((await runtime.reportData(run.id)).sample.rawOpinions).toBe(5);
    expect(proxy.fetchImpl).not.toHaveBeenCalled(); expect(bridge.calls).toEqual([]);
  });
});

describe('browser identity and extension response boundaries', () => {
  it.each(['fetch rejection', 'interrupted response stream'])('retries a Chrome %s through the fixed browser viewer', async (failure) => {
    let detailAttempts = 0;
    const proxy = service(async (body) => {
      if (body.kind === 'detail' && ++detailAttempts === 1) {
        if (failure === 'fetch rejection') throw new TypeError('Failed to fetch');
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {controller.enqueue(new TextEncoder().encode('{"protocolVersion":1,'));},
          pull(controller) {controller.error(new TypeError('Failed to fetch'));}
        }), {headers: {'content-type': 'application/json', 'X-Finitude-Account-Viewer': 'account-A'}});
      }
      return proxyResponse(body);
    });
    const authorization = await proxy.session.analysisRequest(), sleep = vi.fn(async () => undefined);
    const classifier = new AiClassifier({proxy: {baseUrl: '/naruto/api/v1', request: authorization.request}, concurrency: 1, sleep});
    const output = await classifier.classifyAll([opinion], [content]);
    expect(sleep).toHaveBeenCalledTimes(1); expect(sleep).toHaveBeenCalledWith(1000);
    expect(output.newCacheRecords.map((record) => record.opinionId)).toEqual([opinion.id]);
    expect(output.classifications[0].reportEligible).toBe(true);
    const calls = proxy.fetchImpl.mock.calls.filter(([path]) => String(path).endsWith('/classify'));
    expect(calls.map(([, init]) => JSON.parse(String(init?.body)).kind)).toEqual(['triage', 'detail', 'detail']);
    expect(calls[1][1]?.body).toBe(calls[2][1]?.body);
    for (const [, init] of calls) {
      expect(new Headers(init?.headers).get('X-Finitude-Account-Viewer')).toBe('account-A');
      expect(init?.credentials).toBe('same-origin');
    }
    expect(proxy.session.currentAccount?.userId).toBe('account-A');
    expect(proxy.fetchImpl.mock.calls.filter(([path]) => String(path).startsWith('/auth/'))).toHaveLength(1);
  });

  it('rejects a pending transport retry after account invalidation without another HTTP request or adopted cache', async () => {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {release = resolve;});
    const retryStarted = new Promise<void>((resolve) => {started = resolve;});
    const proxy = service(async (body) => {
      if (body.kind === 'detail') throw new TypeError('Failed to fetch');
      return proxyResponse(body);
    });
    const authorization = await proxy.session.analysisRequest();
    const classifier = new AiClassifier({proxy: {baseUrl: '/naruto/api/v1', request: authorization.request}, concurrency: 1,
      sleep: async () => {started(); await gate;}});
    const adopted: string[] = [];
    const pending = classifier.classifyAll([opinion], [content], [], async (_progress, records) => {
      adopted.push(...records.map((record) => record.opinionId));
    });
    const rejected = expect(pending).rejects.toThrow('取消');
    await retryStarted;
    expect(proxy.session.currentAccount?.userId).toBe('account-A');
    proxy.session.invalidate(); release();
    await rejected;
    expect(proxy.fetchImpl.mock.calls.filter(([path]) => String(path).endsWith('/classify'))).toHaveLength(2);
    expect(proxy.session.currentAccount).toBeUndefined();
    expect(adopted).toEqual([]);
  });

  it('uses the global receiver required by native browser fetch for account and classification requests', async () => {
    const backend = service();
    const fetchImpl = function (this: unknown, input: string | URL | Request, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return backend.fetchImpl(input, init);
    } as typeof fetch;
    const session = new BrowserAnalysisSession(fetchImpl);
    const analysis = await session.analysisRequest();
    expect(session.currentAccount?.userId).toBe('account-A');
    const response = await analysis.request('/naruto/api/v1/classify', {method: 'POST',
      body: JSON.stringify({kind: 'triage', batch: [{opinionId: opinion.id}]})});
    expect(response.ok).toBe(true);
    expect((await response.json()).results[0].opinionId).toBe(opinion.id);
  });
  it('sends only de-identified v1 batches through Archtree with a cookie viewer fence and compatible SHA-256 cache', async () => {
    const proxy = service(), authorization = await proxy.session.analysisRequest();
    const classifier = new AiClassifier({proxy: {baseUrl: '/naruto/api/v1', request: authorization.request}, concurrency: 1});
    const output = await classifier.classifyAll([opinion], [content]);
    const calls = proxy.fetchImpl.mock.calls.filter(([path]) => String(path).endsWith('/classify'));
    expect(calls).toHaveLength(2);
    for (const [path, init] of calls) {
      expect(path).toBe('/naruto/api/v1/classify');
      expect(init?.credentials).toBe('same-origin');
      expect(new Headers(init?.headers).get('X-Finitude-Account-Viewer')).toBe('account-A');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      expect(String(init?.body)).not.toMatch(/123456|私有作者名称|private-author-hash|space\.bilibili|sourceUrl|author/);
    }
    const input = JSON.parse(String(calls[0][1]?.body)).batch[0];
    const expected = createHash('sha256').update(JSON.stringify({promptVersion: 'naruto-opinion-v4',
      triageVersion: 'naruto-decisions-v1', model: 'gpt-6-luna', reasoningEffort: 'medium', input})).digest('hex');
    expect(output.newCacheRecords[0].inputHash).toBe(expected);
  });

  it('rejects provider URLs, desktop bearer headers, and a body that arrives after an account transition', async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {release = resolve;});
    const proxy = service(async (body) => {await delayed; return proxyResponse(body);});
    const authorization = await proxy.session.analysisRequest();
    await expect(authorization.request('https://api.openai.com/v1/responses', {method: 'POST'})).rejects.toThrow('地址');
    await expect(authorization.request('/naruto/api/v1/classify', {method: 'POST', headers: {Authorization: 'Bearer desktop'}}))
      .rejects.toThrow('桌面');
    const pending = authorization.request('/naruto/api/v1/classify', {method: 'POST', body: JSON.stringify({kind: 'detail', batch: [{opinionId: opinion.id}]})});
    const rejected = expect(pending).rejects.toThrow('账户已改变');
    proxy.session.invalidate(); release();
    await rejected;
  });

  it('refreshes expired access once under the shared session lock and retries with the same viewer', async () => {
    let expired = false, rotations = 0, classifications = 0;
    const manager = lockManager(), names: string[] = [];
    const locks = {request: (name: string, options: unknown, operation: () => Promise<unknown>) => {
      names.push(name); return manager.request(name, options as LockOptions, operation as LockGrantedCallback<unknown>);
    }} as LockManager;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/naruto/api/v1/status') return Response.json({enabled: true, protocolVersion: 1, model: 'gpt-6-luna'});
      if (path === '/auth/browser/session') return expired ? Response.json({}, {status: 401})
        : Response.json({user: {id: 'account-A', email: 'account@example.com', role: 'user'}});
      if (path === '/auth/browser/refresh') {
        rotations += 1;
        expect(new Headers(init?.headers).get('X-Finitude-Session-Transition')).toBe('web-locks-v1');
        expect(new Headers(init?.headers).get('X-Finitude-Account-Viewer')).toBe('account-A');
        expect(init?.credentials).toBe('same-origin');
        expect(init?.body).toBe('{}');
        expired = false;
        return Response.json({user: {id: 'account-A', email: 'account@example.com', role: 'user'}},
          {headers: {'X-Finitude-Account-Viewer': 'account-A'}});
      }
      classifications += 1;
      return expired ? Response.json({}, {status: 401}) : proxyResponse(JSON.parse(String(init?.body)));
    });
    const session = new BrowserAnalysisSession(fetchImpl as typeof fetch, undefined, locks), authorization = await session.analysisRequest();
    expired = true;
    await expect(authorization.request('/naruto/api/v1/classify', {method: 'POST', body: JSON.stringify({kind: 'detail', batch: [{opinionId: opinion.id}]})}))
      .resolves.toHaveProperty('status', 200);
    expect(names).toEqual(['finitude:browser-session-transition']);
    expect(rotations).toBe(1); expect(classifications).toBe(2);
    expect(session.currentAccount?.userId).toBe('account-A');
  });

  it('preserves the resolved viewer when refresh is temporarily unavailable and clears it only after locked absence proof', async () => {
    let expired = false, refreshStatus = 503;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/naruto/api/v1/status') return Response.json({enabled: true, protocolVersion: 1, model: 'gpt-6-luna'});
      if (path === '/auth/browser/session') return expired ? Response.json({}, {status: 401})
        : Response.json({user: {id: 'account-A', email: 'account@example.com', role: 'user'}});
      return Response.json({}, {status: refreshStatus});
    });
    const session = new BrowserAnalysisSession(fetchImpl as typeof fetch, undefined, lockManager());
    await session.account(); expired = true;
    await expect(session.account()).rejects.toThrow('续期暂时不可用');
    expect(session.currentAccount?.userId).toBe('account-A');
    refreshStatus = 401;
    await expect(session.account()).resolves.toBeUndefined();
    expect(session.currentAccount).toBeUndefined();
    expect(fetchImpl.mock.calls.filter(([path]) => String(path) === '/auth/browser/refresh')).toHaveLength(2);
  });

  it('rejects successful classification with a missing or different account echo', async () => {
    for (const echo of ['', 'account-B']) {
      const proxy = service(async (body) => {
        const response = proxyResponse(body);
        response.headers.set('X-Finitude-Account-Viewer', echo); return response;
      });
      const authorization = await proxy.session.analysisRequest();
      await expect(authorization.request('/naruto/api/v1/classify', {method: 'POST', body: JSON.stringify({kind: 'detail', batch: [{opinionId: opinion.id}]})}))
        .rejects.toThrow('无法证明当前账户身份');
      expect(proxy.session.currentAccount).toBeUndefined();
    }
  });

  it('rejects a late unbound account response after another response adopted a different identity', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {release = resolve;});
    let probes = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/status')) return Response.json({enabled: true, protocolVersion: 1, model: 'gpt-6-luna'});
      if (++probes === 1) {
        const response = Response.json({});
        response.json = async () => {await gate; return {user: {id: 'account-B', email: 'other@example.com', role: 'user'}};};
        return response;
      }
      return Response.json({user: {id: 'account-A', email: 'account@example.com', role: 'user'}});
    });
    const session = new BrowserAnalysisSession(fetchImpl as typeof fetch);
    const stale = session.account();
    const rejected = expect(stale).rejects.toThrow('账户已改变');
    await Promise.resolve();
    const prepared = await session.analysisRequest();
    expect(session.currentAccount?.userId).toBe('account-A');
    release(); await rejected;
    expect(session.currentAccount).toBeUndefined();
    await expect(prepared.request('/naruto/api/v1/classify', {method: 'POST'})).rejects.toThrow('取消');
  });

  it('does not prepare analysis for a viewer invalidated while the public service status is still pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {release = resolve;});
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/status')) {await gate; return Response.json({enabled: true, protocolVersion: 1, model: 'gpt-6-luna'});}
      return Response.json({user: {id: 'account-A', email: 'account@example.com', role: 'user'}});
    });
    const session = new BrowserAnalysisSession(fetchImpl as typeof fetch), pending = session.analysisRequest();
    const rejected = expect(pending).rejects.toThrow('账户已改变');
    await until(async () => Boolean(session.currentAccount));
    session.invalidate(); release(); await rejected;
  });

  it('ignores foreign origins and windows, resolves only the pending response ID, and reports extension timeout', async () => {
    vi.useFakeTimers();
    const bridge = new ChromeExtensionBridge(window, 20);
    const posted = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const pending = bridge.request<{accepted: boolean}>('start');
    const message = posted.mock.calls[0][0] as {id: string};
    const response = {channel: 'naruto-extension-v1', direction: 'response', id: message.id, result: {accepted: true}};
    let resolved = false; void pending.then(() => {resolved = true;});
    window.dispatchEvent(new MessageEvent('message', {source: window, origin: 'https://evil.example', data: response}));
    window.dispatchEvent(new MessageEvent('message', {source: null, origin: window.location.origin, data: response}));
    await Promise.resolve(); expect(resolved).toBe(false);
    window.dispatchEvent(new MessageEvent('message', {source: window, origin: window.location.origin, data: response}));
    await expect(pending).resolves.toEqual({accepted: true});
    const timeout = expect(bridge.request('status')).rejects.toThrow('扩展响应');
    await vi.advanceTimersByTimeAsync(20); await timeout;
    bridge.dispose(); posted.mockRestore(); vi.useRealTimers();
  });
});

describe('desktop-compatible browser archives and full records', () => {
  it('round-trips raw metadata, rewrites local run identity, and imports an active archive paused without network work', async () => {
    const archive = encodeRunArchive(snapshot());
    const imported = decodeRunArchive(archive, '20261013T000001-87654321');
    expect(imported.manifest.importedFrom?.runId).toBe(runId);
    expect(imported.opinions[0].runId).toBe(imported.id);
    expect(imported.opinions[0].authorName).toBe(opinion.authorName);
    expect(imported.contents[0].url).toBe(content.url);
    const active = snapshot('paused'); active.manifest.state = 'processing';
    const bytes = zipSync({[`${runId}/manifest.json`]: strToU8(JSON.stringify(active.manifest))});
    expect(decodeRunArchive(bytes).manifest.state).toBe('paused');
  });

  it('rejects foreign collection URLs, duplicate file names, credential files, traversal, corrupt CRCs and oversized output', () => {
    const base = strToU8(JSON.stringify(manifest()));
    for (const extra of ['../escape.json', 'credentials.json', 'raw/../opinions.jsonl']) {
      expect(() => decodeRunArchive(zipSync({'manifest.json': base, [extra]: strToU8('{}')}))).toThrow();
    }
    expect(() => decodeRunArchive(zipSync({'manifest.json': base, 'checkpoint.json': strToU8(JSON.stringify({
      ...snapshot().checkpoint, pendingCandidates: [{...content, url: 'https://evil.example/private'}]}))}))).toThrow();
    expect(() => decodeRunArchive(zipSync({'manifest.json': base, 'MANIFEST.JSON': base}))).toThrow();
    const corrupt = encodeRunArchive(snapshot()).slice(), view = new DataView(corrupt.buffer);
    for (let index = 0; index < corrupt.length - 46; index += 1) {
      if (view.getUint32(index, true) === 0x02014b50) {view.setUint32(index + 16, 0, true); break;}
    }
    expect(() => decodeRunArchive(corrupt)).toThrow();
    const bomb = zipSync({'manifest.json': base}), bombView = new DataView(bomb.buffer);
    for (let index = 0; index < bomb.length - 46; index += 1) {
      if (bombView.getUint32(index, true) === 0x02014b50) {bombView.setUint32(index + 24, 129 * 1024 * 1024, true); break;}
    }
    expect(() => decodeRunArchive(bomb)).toThrow();
  });

  it('paginates and searches all raw records rather than only the report sample', async () => {
    const store = new BrowserRunStore('records', new IDBFactory()), run = snapshot();
    run.opinions = Array.from({length: 520}, (_, index) => ({...opinion, id: `record-${index}`, text: `公开评论 ${index}`}));
    run.opinions[519].authorName = '最后一位作者';
    await store.create(run);
    const runtime = new BrowserResearchRuntime(store, new FakeBridge(), service().session, new BrowserRunLocks(lockManager()));
    const page = await runtime.records(runId, 'opinions', 500, 20);
    expect(page.total).toBe(520); expect(page.records).toHaveLength(20);
    const found = await runtime.records(runId, 'opinions', 0, 50, '最后一位作者');
    expect(found.total).toBe(1);
    expect((found.records[0] as {record: OpinionRecord}).record.id).toBe('record-519');
    await expect(runtime.records(runId, 'opinions', 0, 1000)).rejects.toThrow('分页');
  });
});
