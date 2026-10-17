import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createApp} from '../../src/api/app';
import {AppConfig} from '../../src/config';
import {FileRunStore} from '../../src/infrastructure/fileRunStore';
import {readSavedKeywords, saveKeywords} from '../../src/services/dataRootSettings';
import {RunManager} from '../../src/services/runManager';

test('saves keyword preferences through the API and restores them in a new application', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-keyword-api-'));
  const settingsPath = join(directory, 'settings.json');
  const config: AppConfig = {host: '127.0.0.1', port: 0, dataRoot: join(directory, 'data'),
    browserChannel: 'chrome', browserHeadless: true, openBrowser: false, uidSalt: 'test',
    analysisTransport: 'proxy', aiModel: 'gpt-6-luna', aiReasoningEffort: 'medium', aiBatchSize: 1, aiConcurrency: 1};
  const servers: ReturnType<ReturnType<typeof createApp>['listen']>[] = [];
  const start = async () => {
    const manager = new RunManager(new FileRunStore(config.dataRoot), config);
    await manager.initialize();
    const app = createApp(manager, config, {
      readSavedKeywords: () => readSavedKeywords(settingsPath),
      saveKeywords: (preferences) => saveKeywords(preferences, settingsPath)
    });
    const server = app.listen(0, config.host);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
  try {
    const base = await start();
    const initial = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(initial.defaults.browserWindowCount, 4);
    assert.equal(initial.defaults.useKeywordPrefix, true);
    const saved = {keywords: ['十月活动', '火影手游 新忍者评价', '氪金意愿'], useKeywordPrefix: false};
    const response = await fetch(`${base}/api/settings/keywords`, {method: 'PUT',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({...saved, keywords: [' 十月活动 ', ...saved.keywords]})});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), saved);
    const restarted = await start();
    const restored = await (await fetch(`${restarted}/api/settings`)).json();
    assert.deepEqual(restored.defaults.keywords, saved.keywords);
    assert.equal(restored.defaults.useKeywordPrefix, false);
    const invalid = await fetch(`${restarted}/api/settings/keywords`, {method: 'PUT',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({keywords: []})});
    assert.equal(invalid.status, 400);
    const external = await fetch(`${restarted}/api/settings/keywords`, {method: 'PUT',
      headers: {'content-type': 'application/json', origin: 'https://external.example'},
      body: JSON.stringify({keywords: ['另一个关键词'], useKeywordPrefix: true})});
    assert.equal(external.status, 403);
    assert.deepEqual(readSavedKeywords(settingsPath), saved);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    await rm(directory, {recursive: true, force: true});
  }
});
