import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ContentRecord, OpinionRecord, ResearchRequest} from '../src/domain/types';
import {FileRunStore} from '../src/infrastructure/fileRunStore';

const request: ResearchRequest = {
  name: '明文溯源测试',
  durationMinutes: 5,
  contentWindowDays: 30,
  keywords: ['火影忍者手游'],
  includeVideos: true,
  includeDynamics: false,
  mode: 'live',
  browserVisible: false,
  browserWindowCount: 1,
  maxSources: 10
};

test('writes author and source identifiers in plain text with the run id on every raw record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-trace-'));
  try {
    const store = new FileRunStore(directory);
    await store.initialize();
    const manifest = await store.createRun(request);
    const content: ContentRecord = {
      id: 'BVTRACE001',
      type: 'video',
      url: 'https://www.bilibili.com/video/BVTRACE001',
      discoveryUrl: 'https://search.bilibili.com/video?keyword=trace',
      title: '可溯源内容',
      discoveryKeyword: '火影忍者手游',
      discoveryRank: 1,
      description: '',
      collectedAt: '2026-08-27T12:00:00.000Z',
      metrics: {}
    };
    const opinion: OpinionRecord = {
      id: 'local-opinion-id',
      contentId: content.id,
      contentType: 'video',
      sourceType: 'comment',
      voiceType: 'viewer',
      text: '这是一条可溯源评论',
      collectedAt: '2026-08-27T12:01:00.000Z',
      authorUid: '12345678',
      authorName: '公开测试用户',
      authorProfileUrl: 'https://space.bilibili.com/12345678',
      sourceRecordId: '987654321',
      likes: 12,
      replies: 3,
      sourceUrl: 'https://www.bilibili.com/video/BVTRACE001?comment_on=1&comment_root_id=987654321'
    };

    await store.appendContent(manifest.id, content);
    await store.appendOpinion(manifest.id, opinion);

    const rawContent = await readFile(join(store.runDirectory(manifest.id), 'raw', 'contents.jsonl'), 'utf8');
    const rawOpinion = await readFile(join(store.runDirectory(manifest.id), 'raw', 'opinions.jsonl'), 'utf8');
    const storedContent = JSON.parse(rawContent) as ContentRecord;
    const storedOpinion = JSON.parse(rawOpinion) as OpinionRecord;

    assert.equal(storedContent.recordSchemaVersion, 2);
    assert.equal(storedContent.runId, manifest.id);
    assert.equal(storedOpinion.recordSchemaVersion, 2);
    assert.equal(storedOpinion.runId, manifest.id);
    assert.equal(storedOpinion.authorUid, '12345678');
    assert.equal(storedOpinion.authorName, '公开测试用户');
    assert.equal(storedOpinion.sourceRecordId, '987654321');
    assert.equal(storedOpinion.sourcePageUrl, storedOpinion.sourceUrl);
    assert.match(rawOpinion, /公开测试用户/);
    assert.match(rawOpinion, /12345678/);
    assert.match(rawOpinion, /987654321/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
