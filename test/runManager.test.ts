import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {AppConfig} from '../src/config';
import {normalizeResearchRequest} from '../src/domain/validation';
import {FileRunStore} from '../src/infrastructure/fileRunStore';
import {RunManager} from '../src/services/runManager';

const waitFor = async (manager: RunManager, runId: string, predicate: (state: string) => boolean) => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const manifest = await manager.get(runId);
    if (predicate(manifest.state)) return manifest;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for run state.');
};

test('demo run safely pauses, resumes, and generates local artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-test-'));
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 3765,
    dataRoot: directory,
    browserChannel: 'chrome',
    browserHeadless: true,
    openBrowser: false,
    uidSalt: 'test-salt',
    aiModel: 'gpt-5.6-luna',
    aiReasoningEffort: 'medium',
    aiBatchSize: 10,
    aiConcurrency: 3
  };
  try {
    const manager = new RunManager(new FileRunStore(directory), config);
    await manager.initialize();
    const started = await manager.start(normalizeResearchRequest({
      keywords: ['火影忍者手游'],
      durationMinutes: 1,
      mode: 'demo'
    }));
    await manager.pause(started.id);
    const paused = await waitFor(manager, started.id, (state) => state === 'paused');
    assert.equal(paused.state, 'paused');
    await manager.resume(started.id);
    const completed = await waitFor(manager, started.id, (state) => state === 'completed');
    assert.equal(completed.reportReady, true);
    assert.deepEqual(completed.progress, {phase: 'completed'});
    assert.ok(completed.counts.opinions > 0);
    const [rawContents, rawOpinions] = await Promise.all([
      manager.store.readContents(started.id),
      manager.store.readOpinions(started.id)
    ]);
    assert.equal(completed.counts.contents, rawContents.length);
    assert.equal(completed.counts.sources, new Set(rawContents.map((item) => item.id)).size);
    assert.equal(completed.counts.opinions, rawOpinions.length);
    assert.equal(completed.counts.validOpinions, rawOpinions.filter((item) => item.voiceType === 'viewer').length);
    const report = await manager.store.readReport(started.id);
    assert.match(report, /一句话结论/);
    assert.match(report, /虚构演示数据/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('switches the active data directory and blocks changes during collection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-root-switch-'));
  const firstRoot = join(directory, 'first');
  const secondRoot = join(directory, 'second');
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 3765,
    dataRoot: firstRoot,
    browserChannel: 'chrome',
    browserHeadless: true,
    openBrowser: false,
    uidSalt: 'test-salt',
    aiModel: 'gpt-5.6-luna',
    aiReasoningEffort: 'medium',
    aiBatchSize: 10,
    aiConcurrency: 3
  };
  try {
    const manager = new RunManager(new FileRunStore(firstRoot), config);
    await manager.initialize();
    assert.equal(await manager.changeDataRoot(secondRoot), resolve(secondRoot));
    assert.equal(manager.store.root, resolve(secondRoot));
    assert.equal(config.dataRoot, resolve(secondRoot));

    const started = await manager.start(normalizeResearchRequest({
      keywords: ['火影忍者手游'],
      durationMinutes: 1,
      mode: 'demo'
    }));
    await assert.rejects(manager.changeDataRoot(firstRoot), /调查正在采集或生成报告/);
    await manager.pause(started.id);
    await waitFor(manager, started.id, (state) => state === 'paused');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
