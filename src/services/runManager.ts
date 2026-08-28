import {EventEmitter} from 'node:events';
import {AppConfig, localUidSalt} from '../config';
import {createCollector} from '../collectors/collectorFactory';
import {
  CollectionContext,
  ResearchRequest,
  RunEvent,
  RunManifest,
  RunState
} from '../domain/types';
import {FileRunStore} from '../infrastructure/fileRunStore';
import {processRun} from '../processing/runProcessor';
import {ChromeConnectionService} from './chromeConnection';

type Directive = 'continue' | 'pause' | 'finalize';

interface ActiveRun {
  directive: Directive;
  baseElapsedMs: number;
  budgetMs: number;
  startedAt: number;
  promise: Promise<void>;
}

const activeStates = new Set<RunState>(['discovering', 'collecting', 'pause_requested', 'processing']);
const collectionTimerStates = new Set<RunState>(['created', 'discovering', 'collecting', 'pause_requested']);

/** Coordinates one local collector per run and preserves cooperative pause semantics. */
export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly backgroundProcessing = new Set<string>();
  private readonly events = new EventEmitter();
  private currentStore: FileRunStore;

  constructor(
    store: FileRunStore,
    private readonly config: AppConfig,
    readonly chromeConnection = new ChromeConnectionService(config)
  ) {
    this.currentStore = store;
    this.events.setMaxListeners(100);
  }

  get store() {
    return this.currentStore;
  }

  async initialize() {
    await this.store.initialize();
    const manifests = await this.store.listManifests();
    await Promise.all(manifests.filter((item) => activeStates.has(item.state)).map(async (item) => {
      const checkpoint = await this.store.readCheckpoint(item.id).catch(() => null);
      await this.store.updateManifest(item.id, (current) => ({
        ...current,
        state: 'paused',
        activeElapsedMs: Math.max(current.activeElapsedMs, checkpoint?.activeElapsedMs ?? 0),
        statusMessage: '上次运行被关闭，进度已保留。可以继续采集或直接生成报告。',
        progress: {phase: 'collecting'}
      }));
      await this.recordEvent(item.id, 'warning', 'run_recovered', '检测到未完成调查，已安全恢复为暂停状态。');
    }));
  }

  async changeDataRoot(dataRoot: string) {
    const nextStore = new FileRunStore(dataRoot);
    if (nextStore.root === this.store.root) return this.store.root;
    const manifests = await this.store.listManifests();
    if (this.active.size > 0 || this.backgroundProcessing.size > 0 || manifests.some((item) => activeStates.has(item.state))) {
      const error = new Error('调查正在采集或生成报告，请等待完成或暂停后再更改存放位置。') as Error & {statusCode: number};
      error.statusCode = 409;
      throw error;
    }

    await nextStore.initialize();
    this.currentStore = nextStore;
    this.config.dataRoot = nextStore.root;
    this.config.uidSalt = localUidSalt(nextStore.root);
    await this.initialize();
    return nextStore.root;
  }

  subscribe(listener: (manifest: RunManifest) => void) {
    this.events.on('manifest', listener);
    return () => this.events.off('manifest', listener);
  }

  private withLiveElapsed(manifest: RunManifest) {
    const active = this.active.get(manifest.id);
    if (!active || !collectionTimerStates.has(manifest.state)) return manifest;
    return {
      ...manifest,
      activeElapsedMs: active.baseElapsedMs + Math.max(0, Date.now() - active.startedAt)
    };
  }

  private emit(manifest: RunManifest) {
    this.events.emit('manifest', this.withLiveElapsed(manifest));
  }

  private async update(runId: string, updater: (current: RunManifest) => RunManifest | Promise<RunManifest>) {
    const manifest = await this.store.updateManifest(runId, updater);
    this.emit(manifest);
    return this.withLiveElapsed(manifest);
  }

  private async recordEvent(
    runId: string,
    level: RunEvent['level'],
    type: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    await this.store.appendEvent(runId, {timestamp: new Date().toISOString(), level, type, message, details});
  }

  async start(request: ResearchRequest) {
    if (request.mode === 'live') {
      const lease = await this.chromeConnection.acquire();
      lease.release();
    }
    const manifest = await this.store.createRun(request);
    await this.launch(manifest.id);
    return this.store.getManifest(manifest.id);
  }

  async list() {
    return this.store.listManifests();
  }

  async get(runId: string) {
    return this.withLiveElapsed(await this.store.getManifest(runId));
  }

  async pause(runId: string) {
    const active = this.active.get(runId);
    if (!active) {
      const manifest = await this.get(runId);
      if (manifest.state === 'paused') return manifest;
      throw new Error('该调查当前没有在采集。');
    }
    active.directive = 'pause';
    await this.recordEvent(runId, 'info', 'pause_requested', '用户请求暂停调查。');
    return this.update(runId, (current) => ({
      ...current,
      state: 'pause_requested',
      statusMessage: '正在安全完成当前步骤并保存进度…'
    }));
  }

  async resume(runId: string) {
    const manifest = await this.get(runId);
    if (!['paused', 'failed_recoverable'].includes(manifest.state)) {
      throw new Error('只有已暂停或可恢复的调查才能继续。');
    }
    if (manifest.activeElapsedMs >= manifest.request.durationMinutes * 60_000) {
      throw new Error('采集时间已经用完，可以增加时间或直接生成报告。');
    }
    if (manifest.request.mode === 'live') {
      const lease = await this.chromeConnection.acquire();
      lease.release();
    }
    await this.recordEvent(runId, 'info', 'run_resumed', '用户继续调查。');
    await this.launch(runId);
    return this.get(runId);
  }

  async extend(runId: string, minutes: number) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
      throw new Error('增加时间必须是 1 到 720 分钟。');
    }
    const active = this.active.get(runId);
    if (active) active.budgetMs += minutes * 60_000;
    await this.recordEvent(runId, 'info', 'budget_extended', `调查时间增加 ${minutes} 分钟。`);
    return this.update(runId, (current) => ({
      ...current,
      request: {...current.request, durationMinutes: current.request.durationMinutes + minutes},
      statusMessage: `已增加 ${minutes} 分钟采集时间。`
    }));
  }

  async finalize(runId: string) {
    const active = this.active.get(runId);
    if (active) {
      active.directive = 'finalize';
      await this.recordEvent(runId, 'info', 'finalize_requested', '用户选择提前结束并生成报告。');
      return this.update(runId, (current) => ({
        ...current,
        state: 'pause_requested',
        statusMessage: '正在结束当前步骤，随后生成报告…'
      }));
    }
    const manifest = await this.get(runId);
    if (manifest.reportReady) return manifest;
    if (!['paused', 'failed_recoverable', 'created'].includes(manifest.state)) {
      throw new Error('该调查当前不能直接生成报告。');
    }
    void this.processAndComplete(runId, true);
    return this.get(runId);
  }

  async reanalyze(runId: string) {
    if (this.active.has(runId) || this.backgroundProcessing.has(runId)) {
      throw new Error('该调查正在运行，请等待当前步骤完成。');
    }
    const manifest = await this.get(runId);
    if (manifest.request.mode === 'demo') throw new Error('演示调查继续使用本地规则，不调用 AI。');
    if (!this.config.openAiApiKey) throw new Error('重新分析需要先配置 OPENAI_API_KEY。');
    this.backgroundProcessing.add(runId);
    const processing = await this.update(runId, (current) => ({
      ...current,
      state: 'processing',
      reportReady: false,
      error: undefined,
      statusMessage: `正在使用 ${this.config.aiModel} 重新筛选全部意见…`,
      progress: {phase: 'analyzing', completed: 0, total: current.counts.opinions}
    }));
    await this.recordEvent(runId, 'info', 'ai_reanalysis_started', '用户请求使用 Luna 重新分析已有原始数据。');
    void this.processAndComplete(runId, manifest.stopReason === 'user_finalized', false)
      .finally(() => this.backgroundProcessing.delete(runId));
    return processing;
  }

  private async processAndComplete(runId: string, early: boolean, markProcessing = true) {
    const release = await this.store.acquireRunLock(runId);
    try {
      let manifest = markProcessing
        ? await this.update(runId, (current) => ({
          ...current,
          state: 'processing',
          stopReason: early ? 'user_finalized' : current.stopReason,
          statusMessage: current.request.mode === 'demo'
            ? '正在使用本地演示规则生成报告…'
            : `正在使用 ${this.config.aiModel} 筛选全部意见…`,
          progress: {phase: 'analyzing', completed: 0, total: current.counts.opinions},
          error: undefined
        }))
        : await this.get(runId);
      const result = await processRun(this.store, manifest, this.config, {
        onAiProgress: async ({completed, total, cached}) => {
          await this.update(runId, (current) => ({
            ...current,
            statusMessage: `Luna 正在分析意见：${completed}/${total}${cached ? `（复用 ${cached} 条缓存）` : ''}`,
            progress: {phase: 'analyzing', completed, total}
          }));
        },
        onReporting: async () => {
          await this.update(runId, (current) => ({
            ...current,
            statusMessage: current.request.mode === 'demo'
              ? '本地规则分析完成，正在生成报告…'
              : 'Luna 已完成意见分析，正在生成报告…',
            progress: {phase: 'reporting'}
          }));
        }
      });
      manifest = await this.update(runId, (current) => ({
        ...current,
        state: early ? 'completed_early' : 'completed',
        statusMessage: early ? '已根据当前样本提前生成报告。' : '调查和报告已经完成。',
        progress: {phase: 'completed'},
        reportReady: true,
        analysis: {
          mode: result.analysisMode,
          classifierVersion: result.classifierVersion,
          model: result.model,
          completedAt: new Date().toISOString(),
          strongOpinions: result.strongOpinions,
          weakOpinions: result.weakOpinions,
          noiseOpinions: result.noiseOpinions,
          localHardNoise: result.localHardNoise,
          creatorViewsExcluded: result.creatorViewsExcluded,
          fastTriageSkipped: result.fastTriageSkipped,
          detailedAiOpinions: result.detailedAiOpinions,
          usage: result.aiUsage
        },
        counts: {
          ...current.counts,
          contents: result.rawContentCount,
          sources: result.sourceCount,
          opinions: result.rawOpinionCount,
          validOpinions: result.validOpinions
        }
      }));
      await this.recordEvent(
        runId,
        'info',
        'report_completed',
        result.analysisMode === 'ai' ? 'Luna AI 调查报告已生成。' : '本地演示报告已生成。'
      );
      this.emit(manifest);
    } catch (error) {
      await this.fail(runId, error);
    } finally {
      await release();
    }
  }

  private async launch(runId: string) {
    if (this.active.has(runId)) throw new Error('该调查已经在运行。');
    const release = await this.store.acquireRunLock(runId);
    const manifest = await this.store.getManifest(runId);
    const active: ActiveRun = {
      directive: 'continue',
      baseElapsedMs: manifest.activeElapsedMs,
      budgetMs: manifest.request.durationMinutes * 60_000,
      startedAt: Date.now(),
      promise: Promise.resolve()
    };
    active.promise = this.execute(runId, active)
      .catch((error) => this.fail(runId, error))
      .finally(async () => {
        this.active.delete(runId);
        await release();
      });
    this.active.set(runId, active);
  }

  private async execute(runId: string, active: ActiveRun) {
    const manifest = await this.store.getManifest(runId);
    const checkpoint = await this.store.readCheckpoint(runId);
    const collector = createCollector(manifest.request.mode, this.config, this.chromeConnection);
    const elapsed = () => active.baseElapsedMs + Math.max(0, Date.now() - active.startedAt);
    const remaining = () => Math.max(0, active.budgetMs - elapsed());
    const directive = () => {
      if (active.directive !== 'continue') return active.directive;
      return remaining() <= 0 ? 'budget_exhausted' as const : 'continue' as const;
    };
    const context: CollectionContext = {
      manifest,
      checkpoint,
      callbacks: {
        getDirective: directive,
        remainingMs: remaining,
        onState: async (state, message) => {
          await this.update(runId, (current) => ({
            ...current,
            state,
            statusMessage: message,
            progress: state === 'discovering' || state === 'collecting' ? {phase: state} : current.progress,
            error: undefined
          }));
          await this.recordEvent(runId, 'info', `state_${state}`, message);
        },
        onCandidates: async (candidates) => {
          await this.update(runId, (current) => ({
            ...current,
            counts: {...current.counts, candidates: candidates.length},
            statusMessage: `已发现 ${candidates.length} 个候选来源，准备按热度采集。`
          }));
        },
        onContent: async (content) => {
          await this.store.appendContent(runId, content);
          await this.update(runId, (current) => ({
            ...current,
            statusMessage: `正在分析：${content.title.slice(0, 36)}`,
            counts: {
              ...current.counts,
              contents: current.counts.contents + 1,
              sources: current.counts.sources + 1
            }
          }));
        },
        onOpinion: async (opinion) => {
          await this.store.appendOpinion(runId, opinion);
          await this.update(runId, (current) => ({
            ...current,
            counts: {...current.counts, opinions: current.counts.opinions + 1}
          }));
        },
        onCheckpoint: async (next) => {
          next.activeElapsedMs = elapsed();
          await this.store.writeCheckpoint(runId, next);
          await this.update(runId, (current) => ({...current, activeElapsedMs: next.activeElapsedMs}));
        },
        onWarning: async (message, details) => {
          await this.recordEvent(runId, 'warning', 'collection_warning', message, details);
          await this.update(runId, (current) => ({
            ...current,
            counts: {...current.counts, warnings: current.counts.warnings + 1}
          }));
        }
      }
    };
    const result = await collector.collect(context);
    result.checkpoint.activeElapsedMs = elapsed();
    await this.store.writeCheckpoint(runId, result.checkpoint);

    if (result.outcome === 'paused') {
      await this.update(runId, (current) => ({
        ...current,
        state: 'paused',
        activeElapsedMs: result.checkpoint.activeElapsedMs,
        statusMessage: '调查已暂停，进度已经安全保存。'
      }));
      await this.recordEvent(runId, 'info', 'run_paused', '调查已暂停并保存检查点。');
      return;
    }

    const early = result.outcome === 'finalized';
    const stopReason = early ? 'user_finalized' as const
      : result.outcome === 'budget_exhausted' ? 'budget_exhausted' as const : 'source_exhausted' as const;
    let processingManifest = await this.update(runId, (current) => ({
      ...current,
      state: 'processing',
      activeElapsedMs: result.checkpoint.activeElapsedMs,
      stopReason,
      statusMessage: current.request.mode === 'demo'
        ? '采集结束，正在使用本地演示规则生成报告…'
        : `采集结束，正在使用 ${this.config.aiModel} 筛选全部意见…`,
      progress: {phase: 'analyzing', completed: 0, total: current.counts.opinions}
    }));
    const processed = await processRun(this.store, processingManifest, this.config, {
      onAiProgress: async ({completed, total, cached}) => {
        await this.update(runId, (current) => ({
          ...current,
          statusMessage: `Luna 正在分析意见：${completed}/${total}${cached ? `（复用 ${cached} 条缓存）` : ''}`,
          progress: {phase: 'analyzing', completed, total}
        }));
      },
      onReporting: async () => {
        await this.update(runId, (current) => ({
          ...current,
          statusMessage: current.request.mode === 'demo'
            ? '本地规则分析完成，正在生成报告…'
            : 'Luna 已完成意见分析，正在生成报告…',
          progress: {phase: 'reporting'}
        }));
      }
    });
    processingManifest = await this.update(runId, (current) => ({
      ...current,
      state: early ? 'completed_early' : 'completed',
      reportReady: true,
      analysis: {
        mode: processed.analysisMode,
        classifierVersion: processed.classifierVersion,
        model: processed.model,
        completedAt: new Date().toISOString(),
        strongOpinions: processed.strongOpinions,
        weakOpinions: processed.weakOpinions,
        noiseOpinions: processed.noiseOpinions,
        localHardNoise: processed.localHardNoise,
        creatorViewsExcluded: processed.creatorViewsExcluded,
        fastTriageSkipped: processed.fastTriageSkipped,
        detailedAiOpinions: processed.detailedAiOpinions,
        usage: processed.aiUsage
      },
      statusMessage: early ? '已根据当前样本提前生成报告。' : '调查和报告已经完成。',
      progress: {phase: 'completed'},
      counts: {
        ...current.counts,
        contents: processed.rawContentCount,
        sources: processed.sourceCount,
        opinions: processed.rawOpinionCount,
        validOpinions: processed.validOpinions
      }
    }));
    await this.recordEvent(
      runId,
      'info',
      'report_completed',
      processed.analysisMode === 'ai' ? 'Luna AI 调查报告已生成。' : '本地演示报告已生成。'
    );
    this.emit(processingManifest);
  }

  private async fail(runId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await this.recordEvent(runId, 'error', 'run_failed', '调查遇到可恢复错误。', {error: message}).catch(() => undefined);
    await this.update(runId, (current) => ({
      ...current,
      state: 'failed_recoverable',
      statusMessage: '调查遇到问题，现有进度已保留。可以重试或直接生成。',
      error: message
    })).catch(() => undefined);
  }
}
