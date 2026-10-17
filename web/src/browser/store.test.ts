import {afterEach, describe, expect, it, vi} from 'vitest';
import {IDBFactory, IDBObjectStore} from 'fake-indexeddb';
import {BrowserRunStore} from './store';
import type {BrowserRun} from './types';

const snapshot = (id: string): BrowserRun => ({
  id,
  manifest: {schemaVersion: 1, id, state: 'completed', request: {name: id, durationMinutes: 5, contentWindowDays: 30,
    keywords: ['火影忍者手游'], includeVideos: true, includeArticles: true, mode: 'demo', browserVisible: true,
    browserWindowCount: 1, maxSources: 20}, createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z', activeElapsedMs: 0, statusMessage: '已完成', reportReady: true,
    counts: {candidates: 0, contents: 0, opinions: 0, validOpinions: 0, sources: 0, warnings: 0}},
  checkpoint: {schemaVersion: 1, pendingCandidates: [], seenContentIds: [], seenOpinionIds: [], activeElapsedMs: 0,
    updatedAt: '2026-10-14T00:00:00.000Z'},
  candidates: [], contents: [], opinions: [], processedOpinions: [], classifications: [], aiClassifications: [],
  cache: [], events: [], report: '<html>saved report</html>', quality: {saved: true}
});

afterEach(() => {vi.restoreAllMocks();});

describe('browser snapshot deletion', () => {
  it('deletes only the requested snapshot and preserves other investigations and settings', async () => {
    const store = new BrowserRunStore('delete-snapshot', new IDBFactory());
    const deleted = snapshot('remove'), retained = snapshot('keep');
    await store.create(deleted);
    await store.create(retained);
    await store.setSetting('keywords', {keywords: ['决斗场']});
    await store.delete(deleted.id);
    await expect(store.get(deleted.id)).rejects.toThrow('本机没有这份调查');
    expect(await store.list()).toEqual([retained]);
    expect(await store.getSetting('keywords')).toEqual({keywords: ['决斗场']});
  });

  it('reports a missing investigation instead of claiming it was deleted', async () => {
    const store = new BrowserRunStore('delete-missing', new IDBFactory());
    await expect(store.delete('missing')).rejects.toThrow('本机没有这份调查');
    expect(await store.list()).toEqual([]);
  });

  it('rejects an aborted deletion and leaves the entire saved snapshot intact', async () => {
    const store = new BrowserRunStore('delete-abort', new IDBFactory());
    const run = snapshot('saved');
    await store.create(run);
    const originalDelete = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = originalDelete.call(this, key);
      this.transaction.abort();
      return request;
    });
    await expect(store.delete(run.id)).rejects.toThrow('本机数据写入失败');
    expect(await store.get(run.id)).toEqual(run);
  });
});
