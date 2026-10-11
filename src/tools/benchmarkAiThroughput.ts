import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {loadAppConfig} from '../config';
import {FileRunStore} from '../infrastructure/fileRunStore';
import {AiClassifier} from '../processing/aiClassifier';
import {cleanOpinions} from '../processing/cleaner';

/** Measures fresh provider work without altering a user's investigation or its cache. */
const main = async () => {
  const argumentsByName = new Map(process.argv.slice(2).map((argument) => {
    const equals = argument.indexOf('=');
    return [argument.slice(0, equals), argument.slice(equals + 1)];
  }));
  const runId = argumentsByName.get('--run');
  assert.match(runId ?? '', /^\d{8}T\d{6}-[a-f0-9]{8}$/, 'Provide --run=<existing investigation ID>');
  const config = loadAppConfig();
  assert.ok(config.openAiApiKey, 'An already authorized local OpenAI credential is required');
  const outputPath = resolve(argumentsByName.get('--output') ?? 'build/windows/smoke/performance.json');
  const store = new FileRunStore(config.dataRoot);
  const [manifest, contents, raw, baselineClassifications] = await Promise.all([
    store.getManifest(runId!), store.readContents(runId!), store.readOpinions(runId!), store.readClassifications(runId!)
  ]);
  assert.ok(manifest.reportReady, 'Benchmark only a completed investigation');
  const cleaned = cleanOpinions(raw);
  const baseline = argumentsByName.get('--baseline')
    ? JSON.parse((await readFile(resolve(argumentsByName.get('--baseline')!), 'utf8')).replace(/^\uFEFF/, '')) as {analysisSeconds: number}
    : undefined;
  const classifier = new AiClassifier({
    apiKey: config.openAiApiKey,
    organizationId: config.openAiOrganizationId,
    projectId: config.openAiProjectId,
    model: 'gpt-6-luna', reasoningEffort: 'medium', batchSize: 10, concurrency: 12
  });
  const started = Date.now();
  let lastLog = 0;
  let peakRequests = 0;
  let smallestConcurrency = 12;
  let observedRetry = false;
  let firstDetailMs: number | undefined;
  const result = await classifier.classifyAll(cleaned.opinions, contents, [], async (progress) => {
    const activity = progress.activity;
    if (!activity) return;
    peakRequests = Math.max(peakRequests, activity.inFlightRequests);
    smallestConcurrency = Math.min(smallestConcurrency, activity.effectiveConcurrency ?? 12);
    observedRetry ||= activity.retryingRequests > 0;
    if (activity.detailed > 0 && firstDetailMs === undefined) firstDetailMs = Date.now() - started;
    if (Date.now() - lastLog >= 15_000 || progress.completed === progress.total) {
      lastLog = Date.now();
      process.stdout.write(`${JSON.stringify({elapsedSeconds: Math.round((Date.now() - started) / 1000),
        processed: progress.completed, total: progress.total, screened: activity.screened,
        detailed: activity.detailed, activeRequests: activity.inFlightRequests,
        allowedRequests: activity.effectiveConcurrency, retrying: activity.retryingRequests})}\n`);
    }
  });
  const elapsedSeconds = (Date.now() - started) / 1000;
  const availableContents = new Set(contents.map((item) => item.id));
  assert.equal(result.classifications.length, cleaned.opinions.filter((item) => availableContents.has(item.contentId)).length);
  assert.equal(result.cachedCount, 0, 'Fresh benchmark must not reuse classification results');
  const previousById = new Map(baselineClassifications.map((item) => [item.opinionId, item]));
  const previousEligible = (item: {reportEligible?: boolean; isValid: boolean}) => item.reportEligible ?? item.isValid;
  const eligibleMatches = result.classifications.filter((item) => {
    const previous = previousById.get(item.opinionId);
    return previous && previousEligible(previous) === previousEligible(item);
  }).length;
  const evidence = {
    status: 'completed', checkedAt: new Date().toISOString(), runId,
    transport: 'direct', model: classifier.model, reasoningEffort: classifier.reasoningEffort,
    configuredConcurrency: classifier.concurrency, peakRequests, smallestConcurrency, observedRetry,
    firstDetailSeconds: firstDetailMs === undefined ? undefined : firstDetailMs / 1000,
    elapsedSeconds, baselineSeconds: baseline?.analysisSeconds,
    speedup: baseline?.analysisSeconds ? baseline.analysisSeconds / elapsedSeconds : undefined,
    rawRecords: raw.length, processedRecords: result.classifications.length, cachedRecords: result.cachedCount,
    localExcluded: result.localHardNoiseCount, decisionsSkipped: result.fastTriageSkippedCount,
    detailedRecords: result.detailedCount, usage: result.usage,
    eligibleRecords: result.classifications.filter(previousEligible).length,
    baselineEligibleRecords: baselineClassifications.filter(previousEligible).length,
    baselineEligibilityAgreement: eligibleMatches / result.classifications.length,
    note: 'Fresh direct-provider benchmark; original run and cache are unchanged. The baseline used the Archtree proxy. Agreement with earlier model output is not a gold-label accuracy evaluation.'
  };
  await mkdir(dirname(outputPath), {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
};

main().catch(() => {
  // Provider errors may contain request data; keep diagnostic output free of comments and credentials.
  process.stderr.write('Throughput benchmark failed; original investigation and cache are unchanged.\n');
  process.exitCode = 1;
});
