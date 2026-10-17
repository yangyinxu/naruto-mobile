import {normalizeResearchRequest} from '../../../src/domain/validation';
import type {AiTokenUsage, ContentRecord, OpinionRecord, ResearchRequest, RunManifest} from '../../../src/domain/types';
import {AiClassifier} from '../../../src/processing/aiClassifier';
import {cleanOpinions} from '../../../src/processing/cleaner';
import {buildReport, buildReportData} from '../../../src/processing/reporter';
import {createRunId} from './archive';
import {BrowserAnalysisSession} from './auth';
import {BrowserRunLocks} from './locks';
import {RuleClassifier} from './demoRules';
import type {BrowserRun, ExtensionBridge, ExtensionEvent, RunStorage} from './types';
import {decodeCandidate, decodeCheckpoint, decodeContent, decodeOpinion, object, text, validateTree} from './validation';

const activeStates = new Set(['created', 'discovering', 'collecting', 'pause_requested', 'processing']);
const collectionStopped = (manifest: RunManifest) => Boolean(manifest.stopReason || manifest.reportReady
  || ['analyzing', 'reporting', 'completed'].includes(manifest.progress?.phase ?? ''));
const now = () => new Date().toISOString();
// Portable run events mark collectors that distinguish unloaded comments from an empty source.
// Legacy title-only sources need one explicit-resume repair, never repeated retries of confirmed emptiness.
const commentReadinessMarker = 'comment_readiness_v1';
/** Confirm worker behavior before creating or repairing a live collection. */
const requireCollectionCapabilities = (status: Record<string, unknown>) => {
  if (status.commentReadiness !== 1) throw new Error('请更新至 0.1.2 或更新版本的火影调查扩展，并在 Chrome 扩展管理页重新加载后刷新此页面。');
  if (status.isolatedCollectionWindow !== 1) throw new Error('请更新至 0.1.7 或更新版本的火影调查扩展，并重新加载扩展和刷新网页，采集将在独立窗口运行。');
  if (status.contentWindowEnforced !== 1) throw new Error('请更新至 0.1.9 或更新版本的火影调查扩展，并重新加载扩展和刷新网页，以严格限定内容范围并采集专栏。');
};
type Directive = 'continue' | 'pause' | 'finalize' | 'extend';
interface ActiveJob {
  release: () => void;
  kind: 'collection' | 'analysis';
  directive: Directive;
  queue: Promise<void>;
  controller: AbortController;
  startedAt: number;
  baseElapsedMs: number;
  acceptEvents: boolean;
  timerStarted: boolean;
}

/** Owns local run transitions under one cross-tab lease, committing records before checkpoints. */
export class BrowserResearchRuntime {
  private readonly active = new Map<string, ActiveJob>();
  private readonly listeners = new Map<string, Set<(manifest: RunManifest) => void>>();
  private readonly unsavedFailures = new Map<string, RunManifest>();
  private initialized?: Promise<void>;
  private channel?: BroadcastChannel;

  constructor(
    readonly store: RunStorage,
    readonly bridge: ExtensionBridge,
    readonly analysis = new BrowserAnalysisSession(),
    readonly locks = new BrowserRunLocks(),
    page?: Window
  ) {
    bridge.subscribe((event) => {
      const job = this.active.get(event.runId);
      if (!job || job.kind !== 'collection' || !job.acceptEvents) return;
      job.queue = job.queue.then(async () => {
        if (this.active.get(event.runId) === job) await this.applyExtensionEvent(event);
      }).catch(async (error: unknown) => {await this.fail(event.runId, error);});
    });
    if (page && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('naruto:local-run-change');
      this.channel.onmessage = (event) => {
        if (typeof event.data?.id !== 'string') return;
        if (event.data.deleted === true) {
          this.unsavedFailures.delete(event.data.id);
          return;
        }
        void store.get(event.data.id).then((run) => this.emit(run.manifest, false)).catch(() => undefined);
      };
    }
    page?.addEventListener('pagehide', () => {
      // The extension also stops when its owner tab disappears. Reopen recovery uses the last committed checkpoint.
      for (const [id, job] of this.active) {
        job.directive = 'pause';
        job.controller.abort();
        if (job.kind === 'collection') void bridge.request('pause', {runId: id}).catch(() => undefined);
      }
    });
  }

  initialize() {
    this.initialized ??= this.recover().catch((error) => {this.initialized = undefined; throw error;});
    return this.initialized;
  }

  private async recover() {
    for (const snapshot of await this.store.list()) {
      if (!activeStates.has(snapshot.manifest.state)) continue;
      let release: () => void;
      try {release = await this.locks.acquire(snapshot.id);} catch {continue;}
      try {
        await this.update(snapshot.id, (run) => {
          if (!activeStates.has(run.manifest.state)) return run;
          run.manifest = {...run.manifest, state: 'paused',
            activeElapsedMs: Math.max(run.manifest.activeElapsedMs, run.checkpoint.activeElapsedMs),
            statusMessage: collectionStopped(run.manifest)
              ? '上次分析被关闭，原始数据和分析缓存已保留，可以继续分析。'
              : '上次采集被关闭，已恢复本机检查点，可以继续采集或生成报告。'};
          this.event(run, 'warning', 'run_recovered', run.manifest.statusMessage);
          return run;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '本机恢复状态无法保存；请先导出备份。';
        const failed: RunManifest = {...snapshot.manifest, state: 'failed_recoverable', statusMessage: message, error: message};
        this.unsavedFailures.set(snapshot.id, failed);
        this.emit(failed);
      } finally {release();}
    }
  }

  subscribe(id: string, listener: (manifest: RunManifest) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, listeners);
    listeners.add(listener);
    let subscribed = true;
    void this.initialize().then(() => this.get(id)).then((manifest) => {if (subscribed) listener(manifest);}).catch(() => undefined);
    return () => {subscribed = false; listeners.delete(listener); if (!listeners.size) this.listeners.delete(id);};
  }

  private emit(manifest: RunManifest, broadcast = true) {
    for (const listener of this.listeners.get(manifest.id) ?? []) listener(manifest);
    if (broadcast) this.channel?.postMessage({id: manifest.id});
  }

  private event(run: BrowserRun, level: 'info' | 'warning' | 'error', type: string, message: string) {
    run.events.push({timestamp: now(), level, type, message});
    if (level === 'warning') run.manifest.counts.warnings += 1;
  }

  private async update(id: string, transform: (run: BrowserRun) => BrowserRun) {
    const run = await this.store.update(id, (current) => {
      const result = transform(current);
      result.manifest.updatedAt = now();
      return result;
    });
    this.unsavedFailures.delete(id);
    this.emit(run.manifest);
    return run;
  }

  async list() {
    await this.initialize();
    return (await this.store.list()).map((run) => this.unsavedFailures.get(run.id) ?? run.manifest)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async get(id: string) {
    await this.initialize();
    return this.unsavedFailures.get(id) ?? (await this.store.get(id)).manifest;
  }

  async delete(id: string) {
    await this.initialize();
    const runningMessage = '该调查正在运行，请先暂停采集或等待分析完成后删除。';
    if (this.active.has(id)) throw new Error(runningMessage);
    const release = await this.locks.acquire(id);
    try {
      const run = await this.store.get(id);
      const manifest = this.unsavedFailures.get(id) ?? run.manifest;
      if (this.active.has(id) || activeStates.has(manifest.state)) throw new Error(runningMessage);
      await this.store.delete(id);
      this.unsavedFailures.delete(id);
      this.channel?.postMessage({id, deleted: true});
    } finally {release();}
  }

  private async reserve(id: string, kind: ActiveJob['kind']) {
    if (this.active.has(id)) throw new Error('该调查正在运行，请等待当前步骤完成。');
    const release = await this.locks.acquire(id);
    const job: ActiveJob = {release, kind, directive: 'continue', queue: Promise.resolve(), controller: new AbortController(),
      startedAt: Date.now(), baseElapsedMs: 0, acceptEvents: false, timerStarted: false};
    this.active.set(id, job);
    return job;
  }

  private release(id: string) {
    const job = this.active.get(id);
    this.active.delete(id);
    job?.release();
  }

  private elapsed(id: string, fallback = 0) {
    const job = this.active.get(id);
    return job && job.kind === 'collection' && job.timerStarted
      ? job.baseElapsedMs + Math.max(0, Date.now() - job.startedAt) : fallback;
  }

  private async fail(id: string, error: unknown) {
    const job = this.active.get(id);
    if (!job) return;
    const paused = job.kind === 'analysis' && job.directive === 'pause' && job.controller.signal.aborted;
    job.controller.abort();
    if (job.kind === 'collection') void this.bridge.request('pause', {runId: id}).catch(() => undefined);
    const message = paused ? '分析已暂停，已完成的本机缓存保留，可以继续。'
      : error instanceof Error ? error.message.slice(0, 1000) : '调查步骤失败，已保存的本机数据保留，可以重试。';
    try {
      const saved = await this.store.get(id);
      const failed: RunManifest = {...saved.manifest, state: paused ? 'paused' : 'failed_recoverable',
        statusMessage: message, error: paused ? undefined : message,
        activeElapsedMs: this.elapsed(id, saved.manifest.activeElapsedMs), updatedAt: now()};
      try {
        await this.update(id, (run) => {run.manifest = failed; this.event(run, 'error', 'run_interrupted', message); return run;});
      } catch {
        // Show the failure without pretending that the failing disk committed it.
        this.unsavedFailures.set(id, failed);
        this.emit(failed);
      }
    } finally {this.release(id);}
  }

  async start(value: ResearchRequest) {
    await this.initialize();
    const request = normalizeResearchRequest(value);
    if (request.mode === 'live') {
      await this.analysis.analysisRequest();
      const status = object(await this.bridge.request('status'));
      if (status.connected !== true || status.loginState !== 'logged_in') throw new Error('请先连接扩展并在本机 Chrome 登录 B 站。');
      requireCollectionCapabilities(status);
    }
    const id = createRunId(), timestamp = now();
    const manifest: RunManifest = {schemaVersion: 1, id, request, state: 'created', createdAt: timestamp, updatedAt: timestamp,
      activeElapsedMs: 0, statusMessage: '调查已创建，正在准备本机采集。', progress: {phase: 'preparing'}, reportReady: false,
      counts: {candidates: 0, contents: 0, opinions: 0, validOpinions: 0, sources: 0, warnings: 0}};
    await this.store.create({id, manifest, checkpoint: {schemaVersion: 1, pendingCandidates: [], seenContentIds: [],
      seenOpinionIds: [], activeElapsedMs: 0, updatedAt: timestamp}, candidates: [], contents: [], opinions: [],
      processedOpinions: [], classifications: [], aiClassifications: [], cache: [], events: [
        {timestamp, level: 'info', type: 'run_created', message: '调查已在本机浏览器创建。'},
        {timestamp, level: 'info', type: commentReadinessMarker, message: '采集将等待评论区加载，未就绪来源保留待重试。'}]});
    await this.launchCollection(id, 'start');
    return this.get(id);
  }

  private async launchCollection(id: string, method: 'start' | 'resume', reserved?: ActiveJob) {
    const job = reserved ?? await this.reserve(id, 'collection');
    try {
      job.acceptEvents = false;
      job.timerStarted = false;
      const run = await this.store.get(id);
      if (run.manifest.request.mode === 'live') {
        // A prior failed invocation must finish stopping before new runId-only events can be accepted.
        const status = object(await this.bridge.request('status'));
        requireCollectionCapabilities(status);
        if (typeof status.activeInvestigations === 'number' && status.activeInvestigations > 0) {
          throw new Error('扩展仍在保存上一次采集，请等待暂停完成后重试。');
        }
      }
      job.kind = 'collection'; job.directive = 'continue'; job.baseElapsedMs = run.manifest.activeElapsedMs; job.startedAt = Date.now();
      const collecting = await this.update(id, (current) => {
        if (method === 'resume') this.reconcileLegacyComments(current);
        current.manifest = {...current.manifest, state: 'discovering', error: undefined,
          statusMessage: '正在使用本机浏览器采集公开页面…', progress: {phase: 'discovering'}};
        return current;
      });
      if (run.manifest.request.mode === 'demo') {
        job.acceptEvents = true;
        job.timerStarted = true;
        void this.demoCollect(id).catch((error: unknown) => this.fail(id, error));
      } else {
        job.acceptEvents = true;
        await this.bridge.request(method, {manifest: collecting.manifest, checkpoint: collecting.checkpoint});
        job.startedAt = Date.now();
        job.timerStarted = true;
      }
    } catch (error) {await this.fail(id, error); throw error;}
  }

  /** Requeue legacy creator-only sources atomically while retaining all raw evidence and deduplication IDs. */
  private reconcileLegacyComments(run: BrowserRun) {
    if (run.manifest.request.mode !== 'live' || !['paused', 'failed_recoverable'].includes(run.manifest.state)
      || collectionStopped(run.manifest) || run.events.some((event) => event.type === commentReadinessMarker)) return;
    const seen = new Set(run.checkpoint.seenContentIds);
    const creators = new Set(run.opinions.filter((opinion) => opinion.voiceType === 'creator'
      && opinion.sourceType === 'creator_view').map((opinion) => opinion.contentId));
    const viewers = new Set(run.opinions.filter((opinion) => opinion.voiceType === 'viewer'
      || opinion.sourceType !== 'creator_view').map((opinion) => opinion.contentId));
    const retry = run.contents.filter((content) => seen.has(content.id) && creators.has(content.id) && !viewers.has(content.id));
    const retryIds = new Set(retry.map((content) => content.id));
    const pending = new Map(run.checkpoint.pendingCandidates.map((candidate) => [candidate.id, candidate]));
    const candidates = new Map(run.candidates.map((candidate) => [candidate.id, candidate]));
    for (const id of retryIds) pending.delete(id);
    // Retain discovery metadata, but the saved title lets the worker recognize the existing creator ID after a retitle.
    // An imported archive may retain only the saved content candidate.
    run.checkpoint.pendingCandidates = [...new Map([...retry.map((content) => [content.id,
      {...(candidates.get(content.id) ?? content), title: content.title}] as const),
      ...pending]).values()];
    run.checkpoint.seenContentIds = run.checkpoint.seenContentIds.filter((id) => !retryIds.has(id));
    run.checkpoint.updatedAt = now();
    this.event(run, 'info', commentReadinessMarker, retry.length
      ? `已将 ${retry.length} 个仅保存来源标题的旧记录加入重试，已有数据和采集时间保留。`
      : '已检查旧版采集进度，无需重试已保存的来源。');
  }

  async pause(id: string) {
    await this.initialize();
    const job = this.active.get(id);
    if (!job) {
      const manifest = await this.get(id);
      if (manifest.state === 'paused') return manifest;
      throw new Error('该调查未在当前页面运行，请返回采集页面操作。');
    }
    job.directive = 'pause';
    let result: BrowserRun;
    try {
      result = await this.update(id, (run) => {
        run.manifest.state = 'pause_requested'; run.manifest.statusMessage = '正在暂停并保存当前步骤…'; return run;
      });
    } catch (error) {await this.fail(id, error); throw error;}
    if (job.kind === 'analysis') job.controller.abort();
    else if (result.manifest.request.mode === 'live') {
      try {await this.bridge.request('pause', {runId: id});} catch (error) {await this.fail(id, error); throw error;}
    }
    return result.manifest;
  }

  async resume(id: string) {
    await this.initialize();
    const job = await this.reserve(id, 'collection');
    try {
      const run = await this.store.get(id);
      if (!['paused', 'failed_recoverable'].includes(this.unsavedFailures.get(id)?.state ?? run.manifest.state)) throw new Error('只有已暂停或可恢复的调查才能继续。');
      if (collectionStopped(run.manifest)) return await this.launchAnalysis(id, job);
      if (run.manifest.activeElapsedMs >= run.manifest.request.durationMinutes * 60_000) throw new Error('采集时间已用完，请增加时间或生成报告。');
      if (run.manifest.request.mode === 'live') await this.analysis.analysisRequest();
      await this.launchCollection(id, 'resume', job);
      return this.get(id);
    } catch (error) {this.release(id); throw error;}
  }

  async finalize(id: string) {
    await this.initialize();
    const job = this.active.get(id);
    if (job) {
      if (job.kind === 'analysis') throw new Error('正在生成报告，请等待分析完成。');
      job.directive = 'finalize';
      const run = await this.update(id, (current) => {
        current.manifest.state = 'pause_requested'; current.manifest.statusMessage = '正在结束采集并生成报告…'; return current;
      });
      if (run.manifest.request.mode === 'live') {
        try {await this.bridge.request('finalize', {runId: id});} catch (error) {await this.fail(id, error); throw error;}
      }
      return run.manifest;
    }
    const reserved = await this.reserve(id, 'analysis');
    try {
      const run = await this.store.get(id);
      if (run.manifest.reportReady) {this.release(id); return run.manifest;}
      if (!['created', 'paused', 'failed_recoverable'].includes(this.unsavedFailures.get(id)?.state ?? run.manifest.state)) throw new Error('该调查当前不能直接生成报告。');
      if (!collectionStopped(run.manifest)) await this.update(id, (current) => {
        current.manifest.stopReason = 'user_finalized'; return current;
      });
      return await this.launchAnalysis(id, reserved);
    } catch (error) {this.release(id); throw error;}
  }

  async reanalyze(id: string) {
    await this.initialize();
    const job = await this.reserve(id, 'analysis');
    try {
      const run = await this.store.get(id);
      if (!['paused', 'failed_recoverable', 'completed', 'completed_early'].includes(run.manifest.state)) throw new Error('该调查当前不能重新分析。');
      if (run.manifest.request.mode === 'demo') throw new Error('演示调查使用本机规则，不调用 AI。');
      return await this.launchAnalysis(id, job);
    } catch (error) {this.release(id); throw error;}
  }

  async extend(id: string, minutes: number) {
    await this.initialize();
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) throw new Error('增加时间必须是 1 到 720 分钟。');
    const active = this.active.get(id);
    const release = active ? undefined : await this.locks.acquire(id);
    try {
      const run = await this.update(id, (current) => {
        if (collectionStopped(current.manifest)) throw new Error('采集已结束，请创建新调查继续采样。');
        if (current.manifest.request.durationMinutes > Math.floor(Number.MAX_SAFE_INTEGER / 60_000) - minutes) {
          throw new Error('调查累计采集时间超过安全限制。');
        }
        current.manifest.request.durationMinutes += minutes;
        current.manifest.statusMessage = `已增加 ${minutes} 分钟采集时间。`;
        this.event(current, 'info', 'budget_extended', current.manifest.statusMessage);
        return current;
      });
      // Refresh the extension's immutable budget snapshot by checkpointing before a resume.
      if (active?.kind === 'collection' && run.manifest.request.mode === 'live') {
        active.directive = 'extend';
        await this.bridge.request('pause', {runId: id});
      }
      return run.manifest;
    } finally {release?.();}
  }

  /** All public-record inputs are decoded before they enter durable storage or AI processing. */
  private async applyExtensionEvent(event: ExtensionEvent) {
    if (JSON.stringify(event.payload).length > 20 * 1024 * 1024) throw new Error('扩展消息超过本机安全限制。');
    validateTree(event.payload);
    const job = this.active.get(event.runId);
    if (!job || job.kind !== 'collection') return;
    await this.update(event.runId, (run) => {
      const demo = run.manifest.request.mode === 'demo';
      switch (event.type) {
        case 'state': {
          const payload = object(event.payload);
          if (!['discovering', 'collecting'].includes(String(payload.state))) throw new Error('扩展采集状态不正确。');
          if (job.directive === 'continue') run.manifest.state = payload.state as 'discovering' | 'collecting';
          run.manifest.progress = {phase: payload.state as 'discovering' | 'collecting'};
          run.manifest.statusMessage = text(payload.message, 1000);
          break;
        }
        case 'candidates': {
          if (!Array.isArray(event.payload) || event.payload.length > 200_000) throw new Error('候选来源格式不正确。');
          // Discovery can resume after only some searches ran; retain earlier source coverage.
          const candidates = new Map(run.candidates.map((value) => [value.id, value]));
          for (const value of event.payload) {
            const candidate = decodeCandidate(value, demo);
            candidates.set(candidate.id, candidate);
          }
          if (candidates.size > 200_000) throw new Error('候选来源达到本机安全限制。');
          run.candidates = [...candidates.values()];
          run.manifest.counts.candidates = run.candidates.length;
          break;
        }
        case 'content': {
          const content = decodeContent(event.payload, run.id, demo);
          if (!run.contents.some((item) => item.id === content.id)) {
            if (run.contents.length >= 200_000) throw new Error('本机来源记录达到安全限制，请导出后开始新调查。');
            run.contents.push(content);
          }
          run.manifest.counts.contents = run.contents.length;
          run.manifest.counts.sources = new Set(run.contents.map((item) => item.id)).size;
          break;
        }
        case 'opinion': {
          const opinion = decodeOpinion(event.payload, run.id, demo);
          if (!run.contents.some((content) => content.id === opinion.contentId && content.type === opinion.contentType)) {
            throw new Error('扩展评论的来源尚未保存，已暂停以保留一致的检查点。');
          }
          if (!run.opinions.some((item) => item.id === opinion.id)) {
            if (run.opinions.length >= 200_000) throw new Error('本机意见记录达到安全限制，请导出后开始新调查。');
            run.opinions.push(opinion);
          }
          run.manifest.counts.opinions = run.opinions.length;
          break;
        }
        case 'checkpoint': this.saveCheckpoint(run, event.payload); break;
        case 'warning': {
          const message = text(object(event.payload).message, 10_000);
          this.event(run, 'warning', 'collection_warning', message);
          run.manifest.statusMessage = message;
          break;
        }
        case 'complete': {
          const payload = object(event.payload);
          if (!['paused', 'finalized', 'budget_exhausted', 'source_exhausted'].includes(String(payload.outcome))) throw new Error('扩展结束状态不正确。');
          this.saveCheckpoint(run, payload.checkpoint);
          if (payload.outcome === 'paused') {
            run.manifest.state = 'paused'; run.manifest.statusMessage = '调查已暂停，进度已保存到本机。';
          } else {
            run.manifest.stopReason = payload.outcome === 'finalized' ? 'user_finalized'
              : payload.outcome as 'budget_exhausted' | 'source_exhausted';
            run.manifest.state = 'processing'; run.manifest.progress = {phase: 'analyzing'};
          }
          break;
        }
      }
      return run;
    });
    if (event.type === 'complete') {
      const outcome = object(event.payload).outcome;
      if (outcome === 'paused' && job.directive === 'extend') await this.launchCollection(event.runId, 'resume', job);
      else if (outcome === 'paused') this.release(event.runId);
      else await this.launchAnalysis(event.runId, job);
    }
  }

  private saveCheckpoint(run: BrowserRun, value: unknown) {
    const checkpoint = decodeCheckpoint(value, run.manifest.request.mode === 'demo');
    const contentIds = new Set(run.contents.map((item) => item.id));
    const opinionIds = new Set(run.opinions.map((item) => item.id));
    // An extension cannot mark records durable merely by putting IDs in a checkpoint.
    if (checkpoint.seenContentIds.some((id) => !contentIds.has(id)) || checkpoint.seenOpinionIds.some((id) => !opinionIds.has(id))) {
      throw new Error('检查点包含未保存的数据，已暂停；继续时将从上一个安全检查点重试。');
    }
    checkpoint.activeElapsedMs = Math.max(run.manifest.activeElapsedMs, checkpoint.activeElapsedMs);
    run.checkpoint = checkpoint;
    run.manifest.activeElapsedMs = checkpoint.activeElapsedMs;
  }

  private async launchAnalysis(id: string, job: ActiveJob) {
    job.kind = 'analysis'; job.directive = 'continue';
    const run = await this.update(id, (current) => {
      current.manifest = {...current.manifest, state: 'processing', reportReady: false, error: undefined,
        progress: {phase: 'analyzing'}, statusMessage: '正在复用本机缓存并分析意见…'};
      this.event(current, 'info', 'analysis_started', current.manifest.statusMessage);
      return current;
    });
    void this.process(id, job).catch((error: unknown) => this.fail(id, error));
    return run.manifest;
  }

  private async process(id: string, job: ActiveJob) {
    const run = await this.store.get(id), cleaning = cleanOpinions(run.opinions), demo = run.manifest.request.mode === 'demo';
    let cachedCount = 0;
    let usage: AiTokenUsage | undefined;
    let classifications;
    let classifierVersion;
    if (demo) {
      const classifier = RuleClassifier.load(), byId = new Map(run.contents.map((item) => [item.id, item]));
      classifications = cleaning.opinions.flatMap((opinion) => {
        const content = byId.get(opinion.contentId); return content ? [classifier.classify(opinion, content)] : [];
      });
      classifierVersion = classifier.version;
    } else {
      const proxy = await this.analysis.analysisRequest();
      const classifier = new AiClassifier({model: 'gpt-6-luna', reasoningEffort: 'medium', batchSize: 10,
        concurrency: proxy.concurrency, proxy: {baseUrl: '/naruto/api/v1', request: (input, init) =>
          proxy.request(input, {...init, signal: init?.signal ? AbortSignal.any([init.signal, job.controller.signal]) : job.controller.signal})}});
      const output = await classifier.classifyAll(cleaning.opinions, run.contents, run.cache, async (progress, records) => {
        if (job.controller.signal.aborted) throw new Error('分析已暂停。');
        await this.update(id, (current) => {
          const cache = new Map(current.cache.map((item) => [`${item.opinionId}:${item.inputHash}`, item]));
          for (const record of records) cache.set(`${record.opinionId}:${record.inputHash}`, record);
          current.cache = [...cache.values()];
          current.manifest.progress = {phase: 'analyzing', completed: progress.completed, total: progress.total, activity: progress.activity};
          current.manifest.statusMessage = `Luna 正在分析 ${progress.completed}/${progress.total} 条意见，复用 ${progress.cached} 条缓存。`;
          return current;
        });
      });
      classifications = output.classifications; cachedCount = output.cachedCount; usage = output.usage; classifierVersion = classifier.version;
    }
    if (job.controller.signal.aborted) throw new Error('分析已暂停。');
    const viewers = new Set(cleaning.opinions.filter((item) => item.voiceType === 'viewer').map((item) => item.id));
    const viewerClassifications = classifications.filter((item) => viewers.has(item.opinionId));
    const valid = viewerClassifications.filter((item) => item.reportEligible ?? item.isValid).length;
    const strong = viewerClassifications.filter((item) => item.insightValue === 'strong').length;
    const weak = viewerClassifications.filter((item) => item.insightValue === 'weak').length;
    const local = classifications.filter((item) => item.classifierVersion.endsWith(':local-hard-noise'));
    const creators = local.filter((item) => item.invalidReason === 'creator_view_excluded_from_comment_analysis').length;
    const skipped = classifications.filter((item) => item.classifierVersion.endsWith(':fast-triage')).length;
    const quality = {generatedAt: now(), analysisMode: demo ? 'rule_demo' : 'ai', classifierVersion,
      aiModel: demo ? undefined : 'gpt-6-luna', reasoningEffort: demo ? undefined : 'medium', rawContents: run.contents.length,
      rawOpinions: run.opinions.length, processedOpinions: classifications.length, validOpinions: valid,
      strongOpinions: strong, weakOpinions: weak, noiseOpinions: viewerClassifications.length - strong - weak,
      validCreatorViews: classifications.filter((item) => !viewers.has(item.opinionId) && (item.reportEligible ?? item.isValid)).length,
      invalidOpinions: classifications.filter((item) => !(item.reportEligible ?? item.isValid)).length,
      duplicateOpinions: cleaning.duplicateCount, cachedAiOpinions: cachedCount, localHardNoise: local.length - creators,
      creatorViewsExcluded: creators, fastTriageSkipped: skipped, detailedAiOpinions: demo ? 0 : classifications.length - local.length - skipped,
      cleaningExcludedOpinions: cleaning.rejected.length - cleaning.duplicateCount,
      missingContentOpinions: cleaning.opinions.length - classifications.length, aiUsage: usage, rejected: cleaning.rejected,
      note: demo ? '演示数据使用本机规则，不可作为真实玩家反馈结论。' : '正式报告只使用强洞察且无需复核的观众意见。'};
    await this.update(id, (current) => {
      current.processedOpinions = cleaning.opinions; current.classifications = classifications;
      if (!demo) current.aiClassifications = classifications;
      current.quality = quality;
      current.report = buildReport(current.manifest, current.contents, cleaning.opinions, classifications, quality);
      current.manifest = {...current.manifest, state: current.manifest.stopReason === 'user_finalized' ? 'completed_early' : 'completed',
        reportReady: true, error: undefined, progress: {phase: 'completed'}, statusMessage: '调查报告已生成并保存在本机。',
        counts: {...current.manifest.counts, validOpinions: valid, opinions: current.opinions.length, contents: current.contents.length,
          sources: new Set(current.contents.map((item) => item.id)).size}, analysis: {
          mode: demo ? 'rule_demo' : 'ai', classifierVersion, model: demo ? undefined : 'gpt-6-luna', completedAt: quality.generatedAt,
          strongOpinions: strong, weakOpinions: weak, noiseOpinions: quality.noiseOpinions, localHardNoise: quality.localHardNoise,
          creatorViewsExcluded: creators, fastTriageSkipped: skipped, detailedAiOpinions: quality.detailedAiOpinions,
          processedOpinions: quality.processedOpinions, duplicateOpinions: quality.duplicateOpinions,
          cleaningExcludedOpinions: quality.cleaningExcludedOpinions, missingContentOpinions: quality.missingContentOpinions,
          cachedAiOpinions: cachedCount, usage}};
      this.event(current, 'info', 'report_completed', '调查报告已生成。'); return current;
    });
    this.release(id);
  }

  async records(id: string, kind: 'opinions' | 'contents', offset: number, limit: number, query = '') {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500 || query.length > 200) {
      throw new Error('记录分页或搜索条件不正确。');
    }
    const run = await this.store.get(id), search = query.trim().toLocaleLowerCase();
    if (kind === 'contents') {
      const records = run.contents.filter((item) => !search || [item.title, item.description, item.id, item.url,
        item.discoveryKeyword].join(' ').toLocaleLowerCase().includes(search));
      return {kind, total: records.length, offset, limit, records: records.slice(offset, offset + limit)};
    }
    const byId = new Map(run.contents.map((item) => [item.id, item.title]));
    const records = run.opinions.filter((item) => !search || [item.text, item.id, item.authorName, item.authorUid,
      item.sourceUrl, byId.get(item.contentId)].join(' ').toLocaleLowerCase().includes(search));
    return {kind, total: records.length, offset, limit, records: records.slice(offset, offset + limit)
      .map((record) => ({record, contentTitle: byId.get(record.contentId)}))};
  }

  async reportData(id: string) {
    const run = await this.store.get(id);
    if (!run.manifest.reportReady || !run.quality) throw new Error('报告尚未生成，请继续分析。');
    return buildReportData(run.manifest, run.contents, run.processedOpinions, run.classifications, run.quality);
  }

  /** Local fixtures preserve an installation-free demonstration without asking for any account. */
  private async demoCollect(id: string) {
    const samples = [
      ['服务器与决斗场体验', '晋级赛替身按不出来，延迟导致连招失败，希望显示网络状态'],
      ['新忍者与公平性', '新忍者二技能后摇太短，老忍者无法反打，希望调整判定'],
      ['服务器与回流体验', '回流后每晚决斗场卡顿闪退，组织三个人都掉线，停止充值了'],
      ['高招与商业化', '做了一年金币刚抽到就削弱，保底成本太高，不抽了'],
      ['回流与福利', '活动福利不错，但新手资源追赶太难，希望减少重复日常']
    ];
    let run = await this.store.get(id);
    if (!run.checkpoint.pendingCandidates.length && !run.checkpoint.seenContentIds.length) {
      const candidates = samples.map(([title], index) => ({id: `BVDEMO00${index + 1}`, type: 'video' as const,
        url: `https://www.bilibili.com/video/BVDEMO00${index + 1}`, title: `火影忍者手游：${title}`,
        discoveryKeyword: '火影忍者手游', discoveryRank: index + 1, discoveryUrl: 'demo://popular-search/fire-ninja-mobile'}));
      await this.applyExtensionEvent({channel: 'naruto-extension-v1', direction: 'event', runId: id, type: 'candidates', payload: candidates});
      await this.update(id, (current) => {current.checkpoint.pendingCandidates = candidates; return current;});
      run = await this.store.get(id);
    }
    for (const candidate of run.checkpoint.pendingCandidates) {
      const job = this.active.get(id);
      if (!job) return;
      if (job.directive === 'pause' || job.directive === 'finalize') break;
      if (this.elapsed(id) >= run.manifest.request.durationMinutes * 60_000) break;
      const timestamp = now(), index = candidate.discoveryRank - 1;
      const content: ContentRecord = {...candidate, runId: id, collectedAt: timestamp,
        description: '用于验证本机调查流程的虚构演示数据。', metrics: {views: 100_000, comments: 300}};
      await this.applyExtensionEvent({channel: 'naruto-extension-v1', direction: 'event', runId: id, type: 'content', payload: content});
      const opinion: OpinionRecord = {id: `${candidate.id}-comment-1`, runId: id, contentId: candidate.id, contentType: 'video',
        sourceType: 'comment', voiceType: 'viewer', text: samples[index]?.[1] ?? samples[0][1], collectedAt: timestamp,
        authorName: `演示玩家${index + 1}`, authorUid: `DEMO-UID-${index + 1}`, likes: 100, replies: 10, sourceUrl: candidate.url};
      await this.applyExtensionEvent({channel: 'naruto-extension-v1', direction: 'event', runId: id, type: 'opinion', payload: opinion});
      await this.update(id, (current) => {
        current.checkpoint.pendingCandidates = current.checkpoint.pendingCandidates.filter((item) => item.id !== candidate.id);
        current.checkpoint.seenContentIds = [...new Set([...current.checkpoint.seenContentIds, candidate.id])];
        current.checkpoint.seenOpinionIds = [...new Set([...current.checkpoint.seenOpinionIds, opinion.id])];
        current.checkpoint.activeElapsedMs = this.elapsed(id); current.manifest.activeElapsedMs = current.checkpoint.activeElapsedMs;
        return current;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const job = this.active.get(id);
    if (!job) return;
    run = await this.store.get(id);
    const outcome = job.directive === 'pause' ? 'paused' : job.directive === 'finalize' ? 'finalized'
      : run.checkpoint.pendingCandidates.length ? 'budget_exhausted' : 'source_exhausted';
    await this.applyExtensionEvent({channel: 'naruto-extension-v1', direction: 'event', runId: id,
      type: 'complete', payload: {outcome, checkpoint: run.checkpoint}});
  }
}
