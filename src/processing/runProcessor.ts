import {AppConfig} from '../config';
import {AiTokenUsage, AnalysisMode, ClassificationRecord, RunManifest} from '../domain/types';
import {FileRunStore} from '../infrastructure/fileRunStore';
import {AiClassificationProgress, AiClassifier} from './aiClassifier';
import {cleanOpinions} from './cleaner';
import {buildReport} from './reporter';
import {RuleClassifier} from './ruleClassifier';
import {DEFAULT_NARUTO_PROXY_BASE_URL} from '../services/archtreeAuth';

interface ProcessRunOptions {
  onAiProgress?: (progress: AiClassificationProgress) => Promise<void>;
  onReporting?: () => Promise<void>;
  analysisProxyRequest?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Rebuilds every derived artifact from immutable raw JSONL. */
export const processRun = async (
  store: FileRunStore,
  manifest: RunManifest,
  config?: AppConfig,
  options: ProcessRunOptions = {}
) => {
  const [contents, rawOpinions] = await Promise.all([
    store.readContents(manifest.id),
    store.readOpinions(manifest.id)
  ]);
  const cleaning = cleanOpinions(rawOpinions);
  const analysisMode: AnalysisMode = manifest.request.mode === 'demo' ? 'rule_demo' : 'ai';

  let classifierVersion: string;
  let classifications: ClassificationRecord[];
  let cachedAiOpinions = 0;
  let localHardNoise = 0;
  let creatorViewsExcluded = 0;
  let fastTriageSkipped = 0;
  let detailedAiOpinions = 0;
  let aiUsage: AiTokenUsage | undefined;
  if (analysisMode === 'rule_demo') {
    const classifier = await RuleClassifier.load();
    const contentById = new Map(contents.map((item) => [item.id, item]));
    classifications = cleaning.opinions.flatMap((opinion) => {
      const content = contentById.get(opinion.contentId);
      return content ? [classifier.classify(opinion, content)] : [];
    });
    classifierVersion = classifier.version;
  } else {
    const transport = config?.analysisTransport ?? (config?.openAiApiKey ? 'direct' : 'proxy');
    const proxyReady = transport === 'proxy' && Boolean(options.analysisProxyRequest);
    const directReady = transport === 'direct' && Boolean(config?.openAiApiKey);
    if (!proxyReady && !directReady) {
      throw new Error(transport === 'proxy'
        ? '真实调查必须先登录 Archtree。'
        : '真实调查必须先配置 OPENAI_API_KEY。');
    }
    const activeConfig = config!;
    const classifier = new AiClassifier({
      apiKey: transport === 'direct' ? activeConfig.openAiApiKey : undefined,
      proxy: transport === 'proxy' && options.analysisProxyRequest ? {
        baseUrl: activeConfig.proxyBaseUrl ?? DEFAULT_NARUTO_PROXY_BASE_URL,
        request: options.analysisProxyRequest
      } : undefined,
      model: activeConfig.aiModel,
      reasoningEffort: activeConfig.aiReasoningEffort,
      batchSize: activeConfig.aiBatchSize,
      concurrency: activeConfig.aiConcurrency
    });
    const cache = await store.readAiClassificationCache(manifest.id);
    let cacheWriteQueue = Promise.resolve();
    const output = await classifier.classifyAll(
      cleaning.opinions,
      contents,
      cache,
      async (progress, records) => {
        const write = cacheWriteQueue.then(() => store.appendAiClassificationCache(manifest.id, records));
        cacheWriteQueue = write.catch(() => undefined);
        await write;
        await options.onAiProgress?.(progress);
      }
    );
    await cacheWriteQueue;
    classifications = output.classifications;
    cachedAiOpinions = output.cachedCount;
    localHardNoise = output.localHardNoiseCount;
    fastTriageSkipped = output.fastTriageSkippedCount;
    detailedAiOpinions = output.detailedCount;
    aiUsage = output.usage;
    classifierVersion = classifier.version;
  }

  if (analysisMode === 'ai') {
    const locallyExcluded = classifications.filter((item) => item.classifierVersion.endsWith(':local-hard-noise'));
    creatorViewsExcluded = locallyExcluded.filter((item) => (
      item.invalidReason === 'creator_view_excluded_from_comment_analysis'
    )).length;
    localHardNoise = locallyExcluded.length - creatorViewsExcluded;
    fastTriageSkipped = classifications.filter((item) => item.classifierVersion.endsWith(':fast-triage')).length;
    detailedAiOpinions = classifications.length - locallyExcluded.length - fastTriageSkipped;
  }

  const opinionById = new Map(cleaning.opinions.map((item) => [item.id, item]));
  const viewerClassifications = classifications.filter((item) => (
    opinionById.get(item.opinionId)?.voiceType === 'viewer'
  ));
  const validClassifications = classifications.filter((item) => item.reportEligible ?? item.isValid);
  const validViewerOpinions = viewerClassifications.filter((item) => item.reportEligible ?? item.isValid).length;
  const validCreatorViews = validClassifications.length - validViewerOpinions;
  const strongOpinions = viewerClassifications.filter((item) => item.insightValue === 'strong').length;
  const weakOpinions = viewerClassifications.filter((item) => item.insightValue === 'weak').length;
  const noiseOpinions = viewerClassifications.length - strongOpinions - weakOpinions;
  const quality = {
    generatedAt: new Date().toISOString(),
    analysisMode,
    classifierVersion,
    aiModel: analysisMode === 'ai' ? config?.aiModel : undefined,
    reasoningEffort: analysisMode === 'ai' ? config?.aiReasoningEffort : undefined,
    rawContents: contents.length,
    rawOpinions: rawOpinions.length,
    processedOpinions: cleaning.opinions.length,
    validOpinions: validViewerOpinions,
    strongOpinions,
    weakOpinions,
    noiseOpinions,
    validCreatorViews,
    invalidOpinions: classifications.length - validClassifications.length,
    duplicateOpinions: cleaning.duplicateCount,
    cachedAiOpinions,
    localHardNoise,
    creatorViewsExcluded,
    fastTriageSkipped,
    detailedAiOpinions,
    aiUsage,
    rejected: cleaning.rejected,
    note: analysisMode === 'rule_demo'
      ? '演示数据使用本地规则分类，不能作为真实玩家反馈结论。'
      : '正式报告只使用 Luna 判定为强洞察且无需复核的观众意见；AI 结果仍保留原始证据链。'
  };
  await options.onReporting?.();
  const report = buildReport(manifest, contents, cleaning.opinions, classifications, quality);
  const writes: Array<Promise<void>> = [
    store.writeProcessedOpinions(manifest.id, cleaning.opinions),
    store.writeClassifications(manifest.id, classifications),
    store.writeQualityReport(manifest.id, quality),
    store.writeReport(manifest.id, report)
  ];
  if (analysisMode === 'ai') writes.push(store.writeAiClassifications(manifest.id, classifications));
  await Promise.all(writes);
  return {
    analysisMode,
    classifierVersion,
    model: analysisMode === 'ai' ? config?.aiModel : undefined,
    strongOpinions,
    weakOpinions,
    noiseOpinions,
    validOpinions: validViewerOpinions,
    localHardNoise,
    creatorViewsExcluded,
    fastTriageSkipped,
    detailedAiOpinions,
    aiUsage,
    sourceCount: new Set(contents.map((item) => item.id)).size,
    rawOpinionCount: rawOpinions.length,
    rawContentCount: contents.length,
    report
  };
};
