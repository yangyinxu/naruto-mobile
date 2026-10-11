import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {chromium} from 'playwright';

// Exercise the actual portable package beside an older, valid research server.
// All data and browser profiles are isolated; the investigation uses local fixtures.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = resolve(process.argv[2] || join(projectRoot, 'build', 'windows', '火影调查.exe'));
const evidenceDirectory = join(projectRoot, 'build', 'windows', 'smoke');
const execFileAsync = promisify(execFile);
const ownedPids = new Set();
let child;
let browser;
let launchError;
let fakeMutations = 0;
let isolatedRoot;

const powershell = async (script, timeout = 5_000) => {
  const encoded = Buffer.from(`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ${script}`, 'utf16le').toString('base64');
  const {stdout} = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, timeout, maxBuffer: 1_000_000, encoding: 'utf8'
  });
  return stdout.trim() ? JSON.parse(stdout.trim()) : undefined;
};

const processTreeScript = () => {
  const seeds = [...ownedPids].filter(Number.isSafeInteger).join(',');
  return `
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId | Select-Object ProcessId, ParentProcessId);
    $owned = [System.Collections.Generic.HashSet[int]]::new();
    foreach ($seed in @(${seeds})) { [void]$owned.Add([int]$seed) }
    do {
      $added = $false;
      foreach ($item in $all) {
        if ($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)) { $added = $true }
      }
    } while ($added);
  `;
};

const ownedListeners = async (timeout) => {
  const snapshot = await powershell(`${processTreeScript()}
    $processes = @($all | Where-Object { $owned.Contains([int]$_.ProcessId) });
    $ports = @(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue |
      Where-Object { $owned.Contains([int]$_.OwningProcess) } |
      Select-Object LocalPort, OwningProcess);
    @{ processes = $processes; ports = $ports } | ConvertTo-Json -Compress -Depth 3;
  `, timeout);
  for (const item of snapshot?.processes || []) ownedPids.add(Number(item.ProcessId));
  return [...new Set((snapshot?.ports || []).map(item => Number(item.LocalPort)))];
};

const stopPortable = async () => {
  if (!ownedPids.size) return;
  await powershell(`${processTreeScript()}
    foreach ($item in $all) {
      if ($owned.Contains([int]$item.ProcessId)) { Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    @{ cleaned = $true } | ConvertTo-Json -Compress;
  `).catch(async () => {
    await Promise.allSettled([...ownedPids].map(pid => execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, timeout: 5_000, maxBuffer: 10_000
    })));
  });
  ownedPids.clear();
  child = undefined;
};

const readJson = async (url, timeout = 1_000) => {
  const response = await fetch(url, {signal: AbortSignal.timeout(timeout)});
  assert.equal(response.status, 200, 'Expected a successful local API response');
  return response.json();
};

const launchPortable = async (environment, userData, dataRoot) => {
  launchError = undefined;
  child = spawn(executable, [`--user-data-dir=${userData}`], {
    cwd: isolatedRoot, env: environment, windowsHide: true, stdio: 'ignore'
  });
  child.once('error', error => { launchError = error; });
  assert.ok(child.pid, 'Portable process did not start');
  ownedPids.add(child.pid);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const ports = await ownedListeners(Math.max(100, Math.min(5_000, deadline - Date.now())));
    for (const port of ports) {
      try {
        const settings = await readJson(`http://127.0.0.1:${port}/api/settings`, Math.max(100, Math.min(1_000, deadline - Date.now())));
        if (settings.dataRoot === dataRoot) return {port, settings};
      } catch { /* A process may also own a non-HTTP diagnostic listener. */ }
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  assert.fail('Portable package did not start its own isolated backend within 45 seconds');
};

const assertPackagedAnalysis = settings => {
  assert.equal(settings.analysis.model, 'gpt-6-luna');
  assert.equal(settings.analysis.transport, 'proxy');
  assert.equal(settings.analysis.loginRequired, true);
  assert.equal(settings.analysis.aiConfigured, false);
  assert.equal(settings.analysis.maxConcurrentRequests, 12, 'Packaged AI request cap still uses the old environment setting');
  assert.equal(settings.analysis.batchSize, 10, 'Packaged detail batches exceed the proxy limit');
};

const saveKeywords = async (page, baseUrl) => {
  const saved = page.waitForResponse(response => response.url() === `${baseUrl}/api/settings/keywords`
    && response.request().method() === 'PUT');
  await page.getByRole('button', {name: '保存关键词', exact: true}).click();
  assert.equal((await saved).status(), 200, 'Keyword preferences could not be saved');
};

const assertSavedKeywordsUi = async (page, topics, prefixEnabled) => {
  const input = page.locator('#keywords');
  await input.waitFor({state: 'visible'});
  assert.equal(await input.inputValue(), topics.join('\n'), 'Saved raw keywords were not restored');
  assert.equal(await page.getByRole('checkbox', {name: '自动添加「火影手游」前缀'}).isChecked(), prefixEnabled);
};

const assertParallelOptions = async page => {
  const windows = page.getByRole('combobox', {name: '并行调查标签页数'});
  assert.deepEqual(await windows.locator('option').evaluateAll(options => options.map(option => option.value)), ['4', '8']);
  assert.equal(await windows.inputValue(), '4', 'Parallel investigation does not default to four tabs');
  await windows.selectOption('8');
  assert.equal(await windows.inputValue(), '8');
  await windows.selectOption('4');
};

const compact = value => value.replace(/[\s,]/gu, '');
const assertMeaning = (actual, expected) => assert.ok(compact(actual).includes(compact(expected)), `Missing count explanation: ${expected}`);

/** Read-only UI fixtures exercise count meanings without starting an AI investigation. */
const assertAnalysisCountUi = async (browserInstance, baseUrl) => {
  const now = new Date().toISOString();
  const request = {
    name: '数量口径验证 · 演示数据', durationMinutes: 5, contentWindowDays: 30,
    keywords: ['火影手游 十月活动'], includeVideos: true, includeDynamics: true,
    mode: 'live', browserVisible: true, browserWindowCount: 4, maxSources: 100
  };
  const progressRun = {
    schemaVersion: 1, id: '20261011T180001-a1111111', state: 'processing', request,
    createdAt: now, updatedAt: now, activeElapsedMs: 253_000,
    statusMessage: '数量口径验证，不调用 AI', stopReason: 'source_exhausted', reportReady: false,
    counts: {candidates: 99, contents: 88, opinions: 1556, validOpinions: 0, sources: 88, warnings: 14},
    progress: {
      phase: 'analyzing', completed: 1114, total: 1406,
      activity: {
        stage: 'detail', screened: 1334, screeningTotal: 1334, detailed: 1000, detailTotal: 1292,
        cached: 0, localExcluded: 72, creatorExcluded: 69, noiseExcluded: 3, triageSkipped: 42,
        effectiveConcurrency: 12, configuredConcurrency: 12, inFlightRequests: 12, inFlightOpinions: 120,
        retryingRequests: 0, startedAt: new Date(Date.now() - 80_000).toISOString(), lastResultAt: now,
        oldestRequestStartedAt: new Date(Date.now() - 15_000).toISOString()
      }
    }
  };
  const legacyActive = structuredClone(progressRun);
  legacyActive.id = '20261011T180002-b2222222';
  legacyActive.request.name = '旧版实时进度 · 演示数据';
  for (const field of ['cached', 'localExcluded', 'creatorExcluded', 'noiseExcluded', 'triageSkipped']) delete legacyActive.progress.activity[field];
  const legacyBare = structuredClone(legacyActive);
  legacyBare.id = '20261011T180003-c3333333';
  legacyBare.request.name = '旧版总进度 · 演示数据';
  delete legacyBare.progress.activity;
  const usage = {
    requestCount: 164, inputTokens: 10_000, cachedInputTokens: 4000, cacheWriteInputTokens: 500,
    outputTokens: 2500, reasoningTokens: 1500, totalTokens: 12_500, estimatedCostUsd: 0.012,
    stages: {
      triage: {requestCount: 34, inputTokens: 3000, estimatedCostUsd: 0.002},
      detail: {requestCount: 130, inputTokens: 7000, estimatedCostUsd: 0.01}
    }
  };
  const completedRun = structuredClone(progressRun);
  completedRun.id = '20261011T180004-d4444444';
  completedRun.state = 'completed';
  completedRun.request.name = '完成数量说明 · 演示数据';
  completedRun.statusMessage = '数量说明验证完成';
  completedRun.reportReady = true;
  completedRun.progress = {phase: 'completed', completed: 1406, total: 1406};
  completedRun.counts.validOpinions = 890;
  completedRun.analysis = {
    mode: 'ai', classifierVersion: 'smoke-fixture', model: 'gpt-6-luna', completedAt: now,
    strongOpinions: 900, weakOpinions: 350, noiseOpinions: 87,
    processedOpinions: 1406, duplicateOpinions: 100, cleaningExcludedOpinions: 20, missingContentOpinions: 30,
    creatorViewsExcluded: 69, localHardNoise: 3, fastTriageSkipped: 42, detailedAiOpinions: 1292,
    cachedAiOpinions: 100, usage
  };
  const legacyCompleted = structuredClone(completedRun);
  legacyCompleted.id = '20261011T180005-e5555555';
  legacyCompleted.request.name = '旧版完成数量 · 演示数据';
  for (const field of ['processedOpinions', 'duplicateOpinions', 'cleaningExcludedOpinions', 'missingContentOpinions',
    'creatorViewsExcluded', 'localHardNoise', 'fastTriageSkipped', 'detailedAiOpinions', 'cachedAiOpinions', 'usage']) delete legacyCompleted.analysis[field];
  const runs = [progressRun, legacyActive, legacyBare, completedRun, legacyCompleted];
  const runById = new Map(runs.map(run => [run.id, run]));
  const reportData = run => ({
    title: run.request.name, runId: run.id, generatedAt: now,
    conclusion: '这是用于验证数量说明的界面样本，未调用 AI。',
    sample: {
      sourceCount: 88, rawOpinions: 1556, validOpinions: 890, topicCount: 0, warnings: 14,
      confidenceLabel: '界面验证样本', confidenceExplanation: '这些数字用于验证显示口径，不是真实调查结果。'
    },
    topics: [],
    quality: {
      analysisMode: 'ai', analysisLabel: 'Luna 6 数量说明样本', model: 'gpt-6-luna',
      strongOpinions: 900, weakOpinions: 350, noiseOpinions: 87, duplicateOpinions: 100,
      creatorViewsExcluded: 69, localHardNoise: 3, fastTriageSkipped: 42, cachedAiOpinions: 100,
      detailedAiOpinions: 1292, usage: run.id === completedRun.id ? usage : undefined,
      usageExplanation: '只验证数字含义，不调用 API。'
    },
    limitations: ['界面验证样本，不是真实调查结果。']
  });
  let mutations = 0;
  const page = await browserInstance.newPage({viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(10_000);
  try {
    await page.addInitScript(({fixtures}) => {
      const snapshots = new Map(fixtures.map(run => [run.id, run]));
      // Keep the read-only event stream connected after its initial snapshot.
      window.EventSource = class {
        readyState = 1;
        constructor(url) {
          const match = String(url).match(/\/api\/runs\/([^/]+)\/events$/u);
          const snapshot = snapshots.get(match?.[1]);
          this.timer = setTimeout(() => {
            this.onopen?.(new Event('open'));
            if (snapshot) this.onmessage?.(new MessageEvent('message', {data: JSON.stringify(snapshot)}));
          }, 0);
        }
        close() { clearTimeout(this.timer); this.readyState = 2; }
      };
    }, {fixtures: runs});
    await page.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== baseUrl) return route.abort();
      if (route.request().method() !== 'GET') {
        mutations += 1;
        return route.abort();
      }
      if (requestUrl.pathname === '/api/runs') return route.fulfill({json: {runs}});
      const match = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(report-data|report))?$/u);
      const run = match && runById.get(match[1]);
      if (!run) return route.continue();
      if (match[2] === 'report-data') return route.fulfill({json: {report: reportData(run)}});
      if (match[2] === 'report') return route.fulfill({contentType: 'text/markdown', body: '# 数量说明界面样本\n\n未调用 API。'});
      return route.fulfill({json: {run, events: []}});
    });
    await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
    const openFixture = async run => {
      await page.locator('header nav').getByRole('button', {name: /^历史调查/u}).click();
      await page.locator('.run-overview').filter({hasText: run.request.name}).click();
    };
    await openFixture(progressRun);
    const live = page.getByLabel('实时分析进度');
    await live.waitFor({state: 'visible'});
    await live.getByText(/正在请求/u).waitFor({state: 'visible'});
    const liveCounts = await live.locator('.analysis-live-counts').innerText();
    assertMeaning(liveCounts, '分析总处理 1114/1406');
    assertMeaning(liveCounts, 'Decisions 已初筛 1334/1334');
    assertMeaning(liveCounts, 'Luna 已详析 1000/1292');
    assertMeaning(liveCounts, 'AI 并行请求上限 12/12');
    assertMeaning(liveCounts, '与 Chrome 采集标签页数分别设置');
    assertMeaning(liveCounts, '正在请求 120 条 · 12 批');
    assertMeaning(liveCounts, '条是记录数，批是 API 请求数');
    assertMeaning(await live.locator('.analysis-live-heading').innerText(), '本次分析已用时');
    assertMeaning(await live.locator('.analysis-live-wait').innerText(), '最早启动的在途请求已等待');
    const breakdown = await page.getByLabel('分析数量口径').innerText();
    assertMeaning(breakdown, '全部记录 1406 = 复用缓存 0 + 本地排除 72 + Decisions 跳过 42 + 需要详析 1292');
    assertMeaning(breakdown, '已完成 1114 = 复用缓存 0 + 本地排除 72 + Decisions 跳过 42 + 详析完成 1000');
    assertMeaning(breakdown, '待完成 292 = 详析待完成 292');
    assertMeaning(breakdown, '本地排除 72 = 作者观点 69 + 明确无信息记录 3');
    assertMeaning(breakdown, '本次统一计入缓存，不再重复计入其他分项');
    const metricText = await page.locator('.metric-grid').innerText();
    assertMeaning(metricText, '原始采集记录 1556');
    assertMeaning(metricText, '清理去重前的记录数，不是玩家人数');
    assertMeaning(metricText, '采集提醒次数 14');
    assertMeaning(metricText, '不代表丢失记录数');
    assertMeaning(await page.locator('.progress-scope').innerText(), '不能用来估计剩余时间');
    assert.equal(await page.getByRole('progressbar', {name: '调查总进度'}).getAttribute('aria-valuenow'), '70');
    await page.screenshot({path: join(evidenceDirectory, 'analysis-progress.png'), fullPage: true});

    await openFixture(legacyActive);
    const legacyBreakdown = page.getByLabel('分析数量口径');
    await legacyBreakdown.waitFor({state: 'visible'});
    assertMeaning(await legacyBreakdown.innerText(), '缓存、本地排除和初筛跳过的分项无法可靠还原');
    assert.equal(await legacyBreakdown.locator('.analysis-count-equation').count(), 0, 'Legacy progress displays guessed breakdown totals');
    await openFixture(legacyBare);
    await page.locator('.count-scope-note').waitFor({state: 'visible'});
    assertMeaning(await page.locator('.count-scope-note').innerText(), '旧版进度没有保存初筛、详析与缓存分项，无法可靠还原');
    assert.equal(await page.getByLabel('实时分析进度').count(), 0);

    await openFixture(completedRun);
    const quality = page.getByLabel('数据质量与 Luna 用量');
    await quality.waitFor({state: 'visible'});
    const qualityText = await quality.innerText();
    assertMeaning(qualityText, '进入报告 890 条');
    assertMeaning(qualityText, '全部强洞察 900 条');
    assertMeaning(qualityText, '需要复核的强洞察不自动入选');
    assertMeaning(qualityText, '已分类观众记录 1337 = 强洞察 900 + 弱信号 350 + 无参考价值 87');
    assertMeaning(qualityText, '详析是处理路径');
    assertMeaning(qualityText, '不能与这些分类数量相加');
    assertMeaning(qualityText, '复用缓存 100 条是已有处理路径中的子集');
    assertMeaning(qualityText, '调用总数 164 = 34 + 130');
    assertMeaning(qualityText, '总 Token 12500');
    assertMeaning(qualityText, '10000 输入 + 2500 输出');
    assertMeaning(qualityText, '推理是输出 Token 的子集，均不再加到总 Token');
    await page.screenshot({path: join(evidenceDirectory, 'report-counts.png'), fullPage: true});
    await page.getByRole('button', {name: '返回调查', exact: true}).click();
    const completedSummary = page.getByLabel('完成分析数量口径');
    await completedSummary.waitFor({state: 'visible'});
    const summaryText = await completedSummary.innerText();
    assertMeaning(summaryText, '原始记录 1556 = 清理去重后的已分类记录 1406 + 重复记录 100 + 其他清理排除 20 + 缺少来源的记录 30');
    assertMeaning(summaryText, '已分类记录 1406 = 作者观点排除 69 + 本地无信息排除 3 + Decisions 跳过 42 + Luna 详析 1292');
    assertMeaning(summaryText, '缓存是其中的子集，不能再加到已分类总数上');
    assertMeaning(summaryText, '报告采用 890 条');
    await openFixture(legacyCompleted);
    await page.getByLabel('报告概况').waitFor({state: 'visible'});
    await page.getByRole('button', {name: '返回调查', exact: true}).click();
    await completedSummary.waitFor({state: 'visible'});
    assertMeaning(await completedSummary.innerText(), '旧版调查未保存完整的清理数量，无法从原始记录数可靠推算去重后的分析总数');
    assert.equal(await completedSummary.locator('.analysis-count-equation').count(), 1, 'Completed legacy investigation guessed cleanup or routing counts');
    assert.ok(!(await completedSummary.innerText()).includes('NaN'));
    assert.equal(mutations, 0, 'Read-only count fixtures sent a mutation');
    return {
      liveEquation: {total: 1406, localExcluded: 72, creatorExcluded: 69, noiseExcluded: 3, triageSkipped: 42, detailTotal: 1292, detailed: 1000, completed: 1114},
      legacyProgressNoGuessedCounts: true, legacyCompletedNoGuessedCounts: true,
      finishedReportMeanings: true, aiConcurrencySeparateFromChromeTabs: true,
      screenshotFiles: ['analysis-progress.png', 'report-counts.png']
    };
  } finally {
    await page.close();
  }
};

const fakeSettings = {
  apiVersion: 8,
  dataRoot: 'OLD_RESEARCH_SERVER_SENTINEL',
  analysis: {aiConfigured: true, loginRequired: false, transport: 'direct', model: 'gpt-5.6-luna'},
  defaults: {keywords: ['火影忍者手游']}
};
const fakeServer = createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method || '')) fakeMutations += 1;
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/health') {
    response.end(JSON.stringify({ok: true, app: 'naruto-mobile-research', apiVersion: 8}));
  } else if (request.url === '/api/settings') {
    response.end(JSON.stringify(fakeSettings));
  } else {
    response.statusCode = 404;
    response.end('{}');
  }
});

try {
  assert.equal(process.platform, 'win32', 'Portable smoke requires Windows');
  const binary = await readFile(executable);
  assert.equal(binary.subarray(0, 2).toString('ascii'), 'MZ', 'Invalid Windows executable');
  const sha256 = createHash('sha256').update(binary).digest('hex');
  isolatedRoot = await mkdtemp(join(tmpdir(), 'naruto-package-smoke-'));
  const dataRoot = join(isolatedRoot, 'research');
  const appData = join(isolatedRoot, 'appdata');
  const localAppData = join(isolatedRoot, 'localappdata');
  const userData = join(isolatedRoot, 'electron-profile');
  await Promise.all([dataRoot, appData, localAppData, userData, evidenceDirectory].map(path => mkdir(path, {recursive: true})));
  await new Promise((resolveListen, reject) => {
    fakeServer.once('error', reject);
    fakeServer.listen(0, '127.0.0.1', resolveListen);
  });
  const fakePort = fakeServer.address().port;
  const fakeUrl = `http://127.0.0.1:${fakePort}`;
  const environment = {...process.env};
  for (const name of Object.keys(environment)) {
    if (['OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'APPDATA', 'LOCALAPPDATA', 'PORT'].includes(name.toUpperCase())) delete environment[name];
  }
  Object.assign(environment, {
    RESEARCH_DATA_DIR: dataRoot,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    NARUTO_DESKTOP_HEADLESS: 'true',
    NO_OPEN: 'true',
    PORT: String(fakePort),
    OPENAI_MODEL: 'gpt-5.6-luna',
    OPENAI_CONCURRENCY: '3',
    NARUTO_MOBILE_ANALYSIS_TRANSPORT: 'direct'
  });
  const {port: ownPort, settings} = await launchPortable(environment, userData, dataRoot);
  assert.notEqual(ownPort, fakePort, 'Portable package reused the older server port');
  assertPackagedAnalysis(settings);
  assert.equal(settings.defaults.browserWindowCount, 4);
  const baseUrl = `http://127.0.0.1:${ownPort}`;
  const health = await readJson(`${baseUrl}/api/health`);
  assert.equal(health.app, 'naruto-mobile-research');
  assert.ok(health.apiVersion >= 10);
  assert.deepEqual(await readJson(`${baseUrl}/api/runs`), {runs: []}, 'Smoke profile contains existing investigations');

  browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(10_000);
  // The smoke never signs in, submits live mode, or loads a remote page.
  await page.route('**/*', route => route.request().url().startsWith(`${baseUrl}/`)
    ? route.continue() : route.abort());
  await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
  const liveCard = page.locator('.mode-card').filter({hasText: '真实调查'});
  await liveCard.waitFor({state: 'visible'});
  const liveModelText = await liveCard.innerText();
  assert.ok(liveModelText.includes('gpt-6-luna'), 'Bundled UI does not identify Luna 6');
  assert.ok(!liveModelText.includes('gpt-5.6-luna'), 'Bundled UI still identifies Luna 5.6');
  const prefix = page.getByRole('checkbox', {name: '自动添加「火影手游」前缀'});
  assert.equal(await prefix.isChecked(), true, 'Keyword prefix is not enabled by default');
  const topics = ['十月活动', '新忍者评价', '氪金意愿'];
  const keywords = topics.map(topic => `火影手游 ${topic}`);
  await assertParallelOptions(page);
  assertMeaning(await page.locator('.setup-card').innerText(), 'AI 分析独立运行，最多 12 个请求并行');
  assertMeaning(await page.locator('.setup-card').innerText(), '每次详析最多 10 条记录');
  await page.locator('#keywords').fill(topics.join('\n'));
  const preview = page.getByLabel('实际搜索词');
  assert.deepEqual(await preview.locator('li').allTextContents(), keywords);
  await saveKeywords(page, baseUrl);
  await page.reload({waitUntil: 'domcontentloaded'});
  await assertSavedKeywordsUi(page, topics, true);
  await prefix.uncheck();
  await saveKeywords(page, baseUrl);
  await page.reload({waitUntil: 'domcontentloaded'});
  await assertSavedKeywordsUi(page, topics, false);
  assert.deepEqual(await preview.locator('li').allTextContents(), topics);
  await prefix.check();
  await saveKeywords(page, baseUrl);
  await page.reload({waitUntil: 'domcontentloaded'});
  await assertSavedKeywordsUi(page, topics, true);
  await page.screenshot({path: join(evidenceDirectory, 'frontend.png'), fullPage: true});
  await page.getByText('本地演示', {exact: true}).click();
  await page.getByRole('spinbutton', {name: '最多采集来源数'}).fill('3');
  const started = page.waitForResponse(response => response.url() === `${baseUrl}/api/runs`
    && response.request().method() === 'POST');
  await page.getByRole('button', {name: '开始调查', exact: true}).click();
  const startResponse = await started;
  assert.equal(startResponse.status(), 201, 'Local demonstration did not start');
  const initialRun = (await startResponse.json()).run;
  assert.equal(initialRun.request.mode, 'demo');
  assert.deepEqual(initialRun.request.keywords, keywords, 'Form submitted different search keywords');
  const completionDeadline = Date.now() + 30_000;
  let run = initialRun;
  while (!run.reportReady && Date.now() < completionDeadline) {
    await delay(250);
    run = (await readJson(`${baseUrl}/api/runs/${initialRun.id}`)).run;
    assert.notEqual(run.state, 'failed_recoverable', 'Local demonstration failed');
  }
  assert.equal(run.reportReady, true, 'Local demonstration did not finish within 30 seconds');
  assert.equal(run.analysis.mode, 'rule_demo');
  const saved = JSON.parse(await readFile(join(dataRoot, 'runs', run.id, 'manifest.json'), 'utf8'));
  assert.deepEqual(saved.request.keywords, keywords, 'Search keywords were not saved locally');
  const report = await fetch(`${baseUrl}/api/runs/${run.id}/report`, {signal: AbortSignal.timeout(2_000)});
  assert.equal(report.status, 200);
  assert.ok((await report.text()).length > 100, 'Local report is empty');
  assert.deepEqual(await readJson(`${fakeUrl}/api/settings`), fakeSettings);
  assert.equal(fakeMutations, 0, 'Portable package modified the older server');

  // Persist the non-default flag so a real process restart proves it was restored.
  await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
  await assertSavedKeywordsUi(page, topics, true);
  await prefix.uncheck();
  await saveKeywords(page, baseUrl);
  await page.close();
  await stopPortable();
  const restarted = await launchPortable(environment, userData, dataRoot);
  assert.notEqual(restarted.port, fakePort);
  assertPackagedAnalysis(restarted.settings);
  assert.deepEqual(restarted.settings.defaults.keywords, topics, 'Raw keywords were not retained across process restart');
  assert.equal(restarted.settings.defaults.useKeywordPrefix, false, 'Prefix preference was not retained across process restart');
  assert.equal(restarted.settings.defaults.browserWindowCount, 4);
  const restartedUrl = `http://127.0.0.1:${restarted.port}`;
  const restartedPage = await browser.newPage({viewport: {width: 1440, height: 1000}});
  restartedPage.setDefaultTimeout(10_000);
  await restartedPage.route('**/*', route => route.request().url().startsWith(`${restartedUrl}/`)
    ? route.continue() : route.abort());
  await restartedPage.goto(restartedUrl, {waitUntil: 'domcontentloaded'});
  await assertSavedKeywordsUi(restartedPage, topics, false);
  await assertParallelOptions(restartedPage);
  assert.ok((await restartedPage.locator('.mode-card').filter({hasText: '真实调查'}).innerText()).includes('gpt-6-luna'));
  await restartedPage.getByRole('checkbox', {name: '自动添加「火影手游」前缀'}).check();
  await saveKeywords(restartedPage, restartedUrl);
  await restartedPage.screenshot({path: join(evidenceDirectory, 'frontend.png'), fullPage: true});
  assert.deepEqual(await readJson(`${fakeUrl}/api/settings`), fakeSettings);
  assert.equal(fakeMutations, 0);
  const countUi = await assertAnalysisCountUi(browser, restartedUrl);
  const evidence = {
    status: 'passed',
    checkedAt: new Date().toISOString(),
    filename: basename(executable),
    sha256,
    olderServerPort: fakePort,
    packageServerPort: ownPort,
    reusedOlderServer: false,
    analysis: {model: settings.analysis.model, transport: settings.analysis.transport, loginRequired: true,
      maxConcurrentRequests: settings.analysis.maxConcurrentRequests, batchSize: settings.analysis.batchSize},
    frontendModelVisible: true,
    keywordPrefixEnabledByDefault: true,
    keywordPreferencesRestoredAfterReload: true,
    keywordPreferencesRestoredAfterProcessRestart: true,
    prefixDisabledRestoredAfterProcessRestart: true,
    restartedPackageServerPort: restarted.port,
    parallelTabs: {default: 4, options: [4, 8], bothSelectable: true},
    countUi,
    savedKeywords: saved.request.keywords,
    demonstration: {state: run.state, reportStatus: report.status, counts: run.counts, analysisMode: run.analysis.mode},
    paidApiCalls: false
  };
  await writeFile(join(evidenceDirectory, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopPortable();
  await new Promise(resolveClose => fakeServer.close(resolveClose));
  if (isolatedRoot) {
    const temporaryParent = resolve(tmpdir());
    const cleanupTarget = resolve(isolatedRoot);
    const fromTemporaryParent = relative(temporaryParent, cleanupTarget);
    assert.ok(fromTemporaryParent && !isAbsolute(fromTemporaryParent)
      && fromTemporaryParent !== '..' && !fromTemporaryParent.startsWith(`..${sep}`)
      && basename(cleanupTarget).startsWith('naruto-package-smoke-'), 'Refusing cleanup outside the isolated smoke directory');
    await rm(cleanupTarget, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
}
