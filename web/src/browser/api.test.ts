import {IDBFactory} from 'fake-indexeddb';
import {beforeAll, describe, expect, it, vi} from 'vitest';

beforeAll(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('browser form preferences', () => {
  it('saves each form choice in this browser and keeps keywords in their own record', async () => {
    const {browserApi, browserRuntime} = await import('./api');
    expect(await browserApi.savePreferences({durationMinutes: 30, mode: 'demo'})).toEqual({durationMinutes: 30, mode: 'demo'});
    expect(await browserApi.savePreferences({keywords: [' 十月活动 ', '十月活动'], useKeywordPrefix: false}))
      .toEqual({durationMinutes: 30, mode: 'demo', keywords: ['十月活动'], useKeywordPrefix: false});
    await browserApi.savePreferences({maxSources: 60});
    const store = browserRuntime().store;
    expect(await store.getSetting('preferences')).toEqual({durationMinutes: 30, mode: 'demo', maxSources: 60});
    expect(await store.getSetting('keywords')).toEqual({keywords: ['十月活动'], useKeywordPrefix: false});
    await expect(browserApi.savePreferences({maxSources: 999})).rejects.toThrow('最大来源数');
    await expect(browserApi.savePreferences({keywords: []})).rejects.toThrow('关键词设置格式不正确');
    await browserApi.savePreferences({includeVideos: false});
    await expect(browserApi.savePreferences({includeArticles: false})).rejects.toThrow('视频和专栏至少选择一种');
    // A rejected change leaves the earlier save untouched.
    expect(await store.getSetting('preferences')).toEqual({durationMinutes: 30, mode: 'demo', maxSources: 60, includeVideos: false});
  });
});

describe('browser defaults on the next visit', () => {
  it('applies saved choices and drops only the damaged parts of a record', async () => {
    // The analysis service is unreachable here; local settings must still load.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    try {
      const {browserApi, browserRuntime} = await import('./api');
      const store = browserRuntime().store;
      await store.setSetting('preferences', {durationMinutes: 30, mode: 'demo', maxSources: 60, includeVideos: false});
      await store.setSetting('keywords', {keywords: ['十月活动'], useKeywordPrefix: false});
      expect((await browserApi.settings()).defaults).toMatchObject({durationMinutes: 30, mode: 'demo', maxSources: 60,
        includeVideos: false, includeArticles: true, keywords: ['十月活动'], useKeywordPrefix: false, browserWindowCount: 4});
      await store.setSetting('preferences', {maxSources: 999, mode: 'demo', contentWindowDays: 45, unknown: true});
      await store.setSetting('keywords', {keywords: '决斗场', useKeywordPrefix: 'yes'});
      const damaged = (await browserApi.settings()).defaults;
      expect(damaged).toMatchObject({maxSources: 20, mode: 'demo', contentWindowDays: 30, keywords: ['火影忍者手游'], useKeywordPrefix: true});
      expect(damaged).not.toHaveProperty('unknown');
      // A later save never echoes the damaged keyword record back to the page.
      expect(await browserApi.savePreferences({durationMinutes: 120})).toEqual({mode: 'demo', durationMinutes: 120});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('saves cut off by closing the page', () => {
  it('journals each save synchronously and replays a leftover on the next visit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    try {
      const {browserApi, browserRuntime} = await import('./api');
      const pending = browserApi.savePreferences({maxSources: 42});
      // Written before any IndexedDB work starts, so even a page that is being closed keeps it.
      expect(JSON.parse(window.localStorage.getItem('naruto-research-unsaved-preferences') ?? '{}')).toMatchObject({maxSources: 42});
      await pending;
      expect(window.localStorage.getItem('naruto-research-unsaved-preferences')).toBeNull();
      // A save that never finished leaves its journal behind; opening the page again applies it.
      window.localStorage.setItem('naruto-research-unsaved-preferences', JSON.stringify({durationMinutes: 45, keywords: ['决斗场'], useKeywordPrefix: false, contentWindowDays: 3}));
      const defaults = (await browserApi.settings()).defaults;
      expect(defaults).toMatchObject({durationMinutes: 45, keywords: ['决斗场'], useKeywordPrefix: false, maxSources: 42});
      expect(defaults.contentWindowDays).not.toBe(3);
      expect(window.localStorage.getItem('naruto-research-unsaved-preferences')).toBeNull();
      expect(await browserRuntime().store.getSetting('preferences')).toMatchObject({durationMinutes: 45, maxSources: 42});
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
