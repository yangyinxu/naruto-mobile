import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createApp} from '../src/api/app';
import {AppConfig} from '../src/config';
import {ContentRecord, OpinionRecord, ResearchRequest} from '../src/domain/types';
import {FileRunStore} from '../src/infrastructure/fileRunStore';
import {RunManager} from '../src/services/runManager';

const request: ResearchRequest = {
  name: '记录接口测试',
  durationMinutes: 5,
  contentWindowDays: 30,
  keywords: ['火影忍者手游'],
  includeVideos: true,
  includeDynamics: false,
  mode: 'demo',
  browserVisible: false,
  browserWindowCount: 1,
  maxSources: 10
};

test('browses complete opinion and content records with search and pagination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-records-api-'));
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 0,
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
  const manager = new RunManager(new FileRunStore(directory), config);
  await manager.initialize();
  const manifest = await manager.store.createRun(request);
  const content: ContentRecord = {
    id: 'BVRECORD001',
    type: 'video',
    url: 'https://www.bilibili.com/video/BVRECORD001',
    title: '火影手游测试视频',
    description: '用于记录浏览测试',
    discoveryKeyword: '火影忍者手游',
    discoveryRank: 1,
    collectedAt: '2026-08-27T12:00:00.000Z',
    metrics: {}
  };
  const opinion: OpinionRecord = {
    id: 'opinion-record-1',
    contentId: content.id,
    contentType: 'video',
    sourceType: 'comment',
    voiceType: 'viewer',
    text: '这条评论可以完整浏览',
    collectedAt: '2026-08-27T12:01:00.000Z',
    authorUid: '123456',
    authorName: '玩家甲',
    sourceRecordId: '998877',
    likes: 3,
    replies: 1,
    sourceUrl: `${content.url}?comment_on=1&comment_root_id=998877`
  };
  await manager.store.appendContent(manifest.id, content);
  await manager.store.appendOpinion(manifest.id, opinion);

  const server = createApp(manager, config).listen(0, config.host);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://${config.host}:${port}/api/runs/${manifest.id}/records`;
    const opinionsResponse = await fetch(`${base}?kind=opinions&offset=0&limit=50&q=${encodeURIComponent('玩家甲')}`);
    assert.equal(opinionsResponse.status, 200);
    const opinions = await opinionsResponse.json() as {
      total: number;
      records: Array<{record: OpinionRecord; contentTitle?: string}>;
    };
    assert.equal(opinions.total, 1);
    assert.equal(opinions.records[0].record.authorUid, '123456');
    assert.equal(opinions.records[0].record.sourceRecordId, '998877');
    assert.equal(opinions.records[0].contentTitle, content.title);

    const contentsResponse = await fetch(`${base}?kind=contents&offset=0&limit=50&q=测试视频`);
    assert.equal(contentsResponse.status, 200);
    const contents = await contentsResponse.json() as {total: number; records: ContentRecord[]};
    assert.equal(contents.total, 1);
    assert.equal(contents.records[0].id, content.id);

    const invalidResponse = await fetch(`${base}?kind=opinions&offset=0&limit=500`);
    assert.equal(invalidResponse.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});
