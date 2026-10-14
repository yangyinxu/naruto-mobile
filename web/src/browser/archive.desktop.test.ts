// @vitest-environment node
import {expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {FileRunStore} from '../../../src/infrastructure/fileRunStore';
import {exportRunArchive, importRunArchive} from '../../../src/services/runArchive';
import {decodeRunArchive, encodeRunArchive} from './archive';

/** Real ZIP parsers on both sides verify browser/EXE compatibility, not just matching test helpers. */
it('imports an EXE ZIP into the browser and imports its browser export back into the desktop store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-browser-interop-'));
  try {
    const source = new FileRunStore(join(directory, 'source'));
    await source.initialize();
    const run = await source.createRun({name: 'portable', durationMinutes: 5, contentWindowDays: 30, keywords: ['火影忍者手游'],
      includeVideos: true, includeDynamics: true, mode: 'live', browserVisible: true, browserWindowCount: 4, maxSources: 20});
    const content = {id: 'BVINTEROP001', runId: run.id, type: 'video' as const,
      url: 'https://www.bilibili.com/video/BVINTEROP001', title: '火影忍者手游测评', description: '公开来源',
      discoveryKeyword: '火影忍者手游', discoveryRank: 1, collectedAt: run.createdAt, metrics: {views: 100}};
    const opinion = {id: 'comment-interop', runId: run.id, contentId: content.id, contentType: 'video' as const,
      sourceType: 'comment' as const, voiceType: 'viewer' as const, text: '后摇太长，无法反打', collectedAt: run.createdAt,
      authorUid: '123', authorName: '公开作者', likes: 10, replies: 1, sourceUrl: content.url};
    await source.appendContent(run.id, content);
    await source.appendOpinion(run.id, opinion);
    await source.writeCheckpoint(run.id, {schemaVersion: 1, pendingCandidates: [], seenContentIds: [content.id],
      seenOpinionIds: [opinion.id], activeElapsedMs: 500, updatedAt: run.createdAt});
    await source.updateManifest(run.id, (manifest) => ({...manifest, state: 'paused', activeElapsedMs: 500,
      counts: {...manifest.counts, contents: 1, sources: 1, opinions: 1}}));
    const desktop = await exportRunArchive(source, run.id);
    const browser = decodeRunArchive(new Uint8Array(desktop.contents));
    expect(browser.opinions[0].authorName).toBe(opinion.authorName);
    expect(browser.checkpoint.seenContentIds).toEqual([content.id]);
    const destination = new FileRunStore(join(directory, 'destination'));
    await destination.initialize();
    const imported = await importRunArchive(destination, Buffer.from(encodeRunArchive(browser)));
    expect(imported.run.state).toBe('paused');
    expect((await destination.readOpinions(imported.run.id))[0].text).toBe(opinion.text);
    expect((await destination.readContents(imported.run.id))[0].runId).toBe(imported.run.id);
    expect((await destination.readCheckpoint(imported.run.id)).activeElapsedMs).toBe(500);
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('naruto-browser-interop-')) {
      throw new Error('Unexpected temporary test directory.');
    }
    await rm(target, {recursive: true, force: true});
  }
});
