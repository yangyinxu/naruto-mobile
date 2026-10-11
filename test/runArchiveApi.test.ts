import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createApp} from '../src/api/app';
import {AppConfig} from '../src/config';
import {ContentRecord, OpinionRecord, ResearchRequest, RunManifest} from '../src/domain/types';
import {FileRunStore} from '../src/infrastructure/fileRunStore';
import {RunManager} from '../src/services/runManager';

const research: ResearchRequest = {
  name: '十月活动与新忍者调查', durationMinutes: 5, contentWindowDays: 30,
  keywords: ['火影手游 十月活动'], includeVideos: true, includeDynamics: false,
  mode: 'demo', browserVisible: false, browserWindowCount: 4, maxSources: 10
};

const configFor = (dataRoot: string): AppConfig => ({
  host: '127.0.0.1', port: 0, dataRoot, browserChannel: 'chrome', browserHeadless: true,
  openBrowser: false, uidSalt: 'archive-test', analysisTransport: 'proxy',
  aiModel: 'gpt-6-luna', aiReasoningEffort: 'medium', aiBatchSize: 10, aiConcurrency: 12
});

const makeFixture = async (manager: RunManager) => {
  const run = await manager.store.createRun(research);
  const content: ContentRecord = {
    id: 'BVARCHIVE001', type: 'video', url: 'https://www.bilibili.com/video/BVARCHIVE001',
    title: '十月新忍者评价', description: '分享调查用的固定测试记录',
    discoveryKeyword: research.keywords[0], discoveryRank: 1,
    collectedAt: '2026-10-11T12:00:00.000Z', metrics: {comments: 1}
  };
  const opinion: OpinionRecord = {
    id: 'archive-opinion-1', contentId: content.id, contentType: 'video',
    sourceType: 'comment', voiceType: 'viewer', text: '火影手游新忍者技能太强，决斗场匹配不公平，希望调整平衡',
    authorUid: '123456', authorName: '测试玩家', sourceRecordId: 'comment-1',
    collectedAt: '2026-10-11T12:01:00.000Z', likes: 3, replies: 0, sourceUrl: content.url
  };
  await manager.store.appendContent(run.id, content);
  await manager.store.appendOpinion(run.id, opinion);
  await manager.store.updateManifest(run.id, (current) => ({...current,
    counts: {...current.counts, candidates: 1, contents: 1, opinions: 1, sources: 1}}));
  await manager.finalize(run.id);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const completed = await manager.get(run.id);
    if (completed.reportReady) return completed;
    assert.notEqual(completed.state, 'failed_recoverable');
    await delay(10);
  }
  throw new Error('Offline fixture report did not finish.');
};

const startApi = async (manager: RunManager, config: AppConfig) => {
  const server = createApp(manager, config).listen(0, config.host);
  await new Promise<void>((resolveReady, reject) => {
    server.once('listening', resolveReady);
    server.once('error', reject);
  });
  config.port = (server.address() as AddressInfo).port;
  return {server, base: `http://127.0.0.1:${config.port}`};
};

const removeFixture = async (directory: string) => {
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}naruto-archive-api-`));
  await rm(directory, {recursive: true, force: true});
};

test('shares a completed survey over ZIP HTTP and reads imported reports without login or new analysis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-archive-api-'));
  const config = configFor(directory);
  const manager = new RunManager(new FileRunStore(directory), config);
  await manager.initialize();
  const original = await makeFixture(manager);
  const originalManifest = await readFile(join(manager.store.runDirectory(original.id), 'manifest.json'));
  const originalReport = await manager.store.readReport(original.id);
  const {server, base} = await startApi(manager, config);
  try {
    const settings = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(settings.apiVersion, 11);
    assert.equal(settings.analysis.loginRequired, true);
    const archiveResponse = await fetch(`${base}/api/runs/${original.id}/archive`);
    assert.equal(archiveResponse.status, 200);
    assert.match(archiveResponse.headers.get('content-type') ?? '', /application\/zip/);
    assert.match(archiveResponse.headers.get('content-disposition') ?? '', /attachment;.*filename\*=UTF-8''/i);
    assert.equal(archiveResponse.headers.get('cache-control'), 'no-store');
    const zip = Buffer.from(await archiveResponse.arrayBuffer());
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    const importedIds = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const importedResponse = await fetch(`${base}/api/runs/import`, {
        method: 'POST', headers: {'content-type': 'application/zip', origin: base}, body: zip
      });
      assert.equal(importedResponse.status, 201);
      const result = await importedResponse.json() as {run: RunManifest; originalRunId: string};
      const imported = result.run;
      importedIds.push(imported.id);
      assert.notEqual(imported.id, original.id);
      assert.equal(result.originalRunId, original.id);
      assert.equal(imported.importedFrom?.runId, original.id);
      assert.equal(imported.createdAt, original.createdAt);
      assert.equal(imported.reportReady, true);
      assert.equal(imported.state, original.state);
      assert.deepEqual(imported.counts, original.counts);
      assert.equal(await (await fetch(`${base}/api/runs/${imported.id}/report`)).text(), originalReport);
      const report = await fetch(`${base}/api/runs/${imported.id}/report-data`);
      assert.equal(report.status, 200);
      assert.equal((await report.json()).report.runId, imported.id);
      const records = await (await fetch(`${base}/api/runs/${imported.id}/records?kind=opinions`)).json();
      assert.equal(records.total, 1);
      assert.equal(records.records[0].record.authorName, '测试玩家');
      assert.equal(records.records[0].record.sourceRecordId, 'comment-1');
      assert.equal(records.records[0].record.runId, imported.id);
    }
    assert.equal(new Set(importedIds).size, 2);
    const history = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(history.runs.length, 3);
    assert.deepEqual(await readFile(join(manager.store.runDirectory(original.id), 'manifest.json')), originalManifest);
    assert.equal(await manager.store.readReport(original.id), originalReport);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await removeFixture(directory);
  }
});

test('rejects invalid ZIP uploads, foreign origins, and exports while a survey is active without changing history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-archive-api-'));
  const config = configFor(directory);
  const manager = new RunManager(new FileRunStore(directory), config);
  await manager.initialize();
  const run = await manager.store.createRun(research);
  await manager.store.updateManifest(run.id, (current) => ({...current, state: 'collecting'}));
  const {server, base} = await startApi(manager, config);
  try {
    const active = await fetch(`${base}/api/runs/${run.id}/archive`);
    assert.equal(active.status, 409);
    assert.match((await active.json()).message, /暂停|完成/);
    const missing = await fetch(`${base}/api/runs/20261011T120000-abcd1234/archive`);
    assert.equal(missing.status, 404);
    for (const contentType of ['application/zip', 'application/json']) {
      const response = await fetch(`${base}/api/runs/import`, {method: 'POST',
        headers: {'content-type': contentType, origin: base}, body: contentType === 'application/json' ? '{}' : 'not a zip'});
      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /ZIP|压缩包|调查/);
    }
    const external = await fetch(`${base}/api/runs/import`, {method: 'POST',
      headers: {'content-type': 'application/zip', origin: 'https://other.example'}, body: 'not a zip'});
    assert.equal(external.status, 403);
    assert.equal((await manager.list()).length, 1);
    assert.equal((await manager.get(run.id)).state, 'collecting');
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await removeFixture(directory);
  }
});

test('blocks archive transfers while a data directory change is in progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-archive-api-'));
  const config = configFor(join(directory, 'original'));
  const manager = new RunManager(new FileRunStore(config.dataRoot), config);
  await manager.initialize();
  let releaseListing!: () => void;
  const listingGate = new Promise<void>((resolveGate) => { releaseListing = resolveGate; });
  manager.store.listManifests = async () => { await listingGate; return []; };
  const changing = manager.changeDataRoot(join(directory, 'next'));
  try {
    await assert.rejects(manager.importArchive(Buffer.from('not a zip')), (error: unknown) => (
      (error as {statusCode: number}).statusCode === 409
    ));
    await assert.rejects(manager.exportArchive('20261011T120000-abcd1234'), (error: unknown) => (
      (error as {statusCode: number}).statusCode === 409
    ));
  } finally {
    releaseListing();
    await changing;
    await removeFixture(directory);
  }
});

test('keeps the original data directory during a transfer and releases the guard after a failed import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-archive-api-'));
  const config = configFor(join(directory, 'original'));
  const manager = new RunManager(new FileRunStore(config.dataRoot), config);
  await manager.initialize();
  try {
    const failedImport = assert.rejects(manager.importArchive(Buffer.from('not a zip')), (error: unknown) => (
      (error as {statusCode: number}).statusCode === 400
    ));
    await assert.rejects(manager.changeDataRoot(join(directory, 'next')), (error: unknown) => (
      (error as {statusCode: number}).statusCode === 409
    ));
    assert.equal(manager.store.root, resolve(directory, 'original'));
    await failedImport;
    assert.equal(await manager.changeDataRoot(join(directory, 'next')), resolve(directory, 'next'));
  } finally {
    await removeFixture(directory);
  }
});
