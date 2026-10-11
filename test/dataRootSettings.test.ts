import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {RequestValidationError} from '../src/domain/validation';
import {readSavedDataRoot, readSavedKeywords, saveDataRoot, saveKeywords} from '../src/services/dataRootSettings';

test('persists and reloads the user-selected data directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-settings-'));
  const settingsPath = join(directory, 'config', 'settings.json');
  const dataRoot = join(directory, 'chosen-data');
  try {
    await saveDataRoot(dataRoot, settingsPath);
    assert.equal(readSavedDataRoot(settingsPath), resolve(dataRoot));
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {dataRoot: resolve(dataRoot)});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('saved keywords survive a fresh module load with prefix disabled and canonical text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-keywords-'));
  const settingsPath = join(directory, 'settings.json');
  try {
    const expected = {keywords: ['十月活动', '新忍者评价', '氪金意愿'], useKeywordPrefix: false};
    assert.deepEqual(await saveKeywords({keywords: [' 十月活动 ', '新忍者评价', '十月活动', '  ', '氪金意愿'], useKeywordPrefix: false}, settingsPath), expected);
    assert.deepEqual(readSavedKeywords(settingsPath), expected);
    const restartedSettings = await import(`../src/services/dataRootSettings.ts?restart=${Date.now()}`);
    assert.deepEqual(restartedSettings.readSavedKeywords(settingsPath), expected);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {keywordSettings: expected});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('saving keywords and data root in either order preserves both preferences and unknown fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-settings-merge-'));
  try {
    for (const order of ['keywords-first', 'data-root-first']) {
      const settingsPath = join(directory, `${order}.json`);
      const dataRoot = join(directory, order);
      const preferences = {keywords: ['十月活动'], useKeywordPrefix: false};
      await writeFile(settingsPath, JSON.stringify({futurePreference: {enabled: true}}), 'utf8');
      if (order === 'keywords-first') {
        await saveKeywords(preferences, settingsPath);
        await saveDataRoot(dataRoot, settingsPath);
      } else {
        await saveDataRoot(dataRoot, settingsPath);
        await saveKeywords(preferences, settingsPath);
      }
      assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {
        futurePreference: {enabled: true},
        dataRoot: resolve(dataRoot),
        keywordSettings: preferences
      });
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('concurrent keyword and directory saves keep the latest value from each without clobbering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-settings-concurrent-'));
  const settingsPath = join(directory, 'settings.json');
  try {
    await writeFile(settingsPath, JSON.stringify({futurePreference: 'preserved'}), 'utf8');
    const writes: Promise<unknown>[] = [];
    for (let index = 0; index < 8; index += 1) {
      writes.push(saveDataRoot(join(directory, `data-${index}`), settingsPath));
      writes.push(saveKeywords({keywords: [`主题 ${index}`], useKeywordPrefix: index % 2 === 0}, settingsPath));
    }
    await Promise.all(writes);
    const expectedPreferences = {keywords: ['主题 7'], useKeywordPrefix: false};
    assert.equal(readSavedDataRoot(settingsPath), resolve(directory, 'data-7'));
    assert.deepEqual(readSavedKeywords(settingsPath), expectedPreferences);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {
      futurePreference: 'preserved',
      dataRoot: resolve(directory, 'data-7'),
      keywordSettings: expectedPreferences
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('keyword saves validate before changing existing settings and enable an omitted prefix flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-keyword-validation-'));
  const settingsPath = join(directory, 'settings.json');
  try {
    const expected = {keywords: ['火影忍者手游', '活动'], useKeywordPrefix: true};
    assert.deepEqual(await saveKeywords({keywords: ['火影忍者手游', '活动']}, settingsPath), expected);
    const invalidPreferences = [
      null,
      [],
      {keywords: '十月活动'},
      {keywords: ['十月活动', 4]},
      {keywords: [' ', '']},
      {keywords: Array.from({length: 13}, (_, index) => `主题${index}`)},
      {keywords: ['字'.repeat(41)], useKeywordPrefix: false},
      {keywords: ['字'.repeat(36)], useKeywordPrefix: true},
      {keywords: ['活动'], useKeywordPrefix: 'false'},
      {keywords: ['活动'], useKeywordPrefix: null}
    ];
    for (const preferences of invalidPreferences) {
      await assert.rejects(saveKeywords(preferences, settingsPath), (error: unknown) => error instanceof RequestValidationError && error.statusCode === 400 && /关键词|搜索词/.test(error.message));
      assert.deepEqual(readSavedKeywords(settingsPath), expected);
    }
    assert.deepEqual(await saveKeywords({keywords: ['字'.repeat(40)], useKeywordPrefix: false}, settingsPath), {keywords: ['字'.repeat(40)], useKeywordPrefix: false});
    assert.deepEqual(await saveKeywords({keywords: [`火影手游${'字'.repeat(36)}`]}, settingsPath), {keywords: [`火影手游${'字'.repeat(36)}`], useKeywordPrefix: true});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('missing or corrupt saved keyword preferences safely fall back without changing the saved directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-keyword-read-'));
  const settingsPath = join(directory, 'settings.json');
  try {
    assert.equal(readSavedKeywords(settingsPath), undefined);
    await writeFile(settingsPath, '{broken', 'utf8');
    assert.equal(readSavedKeywords(settingsPath), undefined);
    const dataRoot = join(directory, 'data');
    await writeFile(settingsPath, JSON.stringify({dataRoot, keywordSettings: {keywords: ['活动'], useKeywordPrefix: 0}}), 'utf8');
    assert.equal(readSavedKeywords(settingsPath), undefined);
    assert.equal(readSavedDataRoot(settingsPath), resolve(dataRoot));
    await writeFile(settingsPath, JSON.stringify({keywordSettings: {keywords: ['活动']}}), 'utf8');
    assert.deepEqual(readSavedKeywords(settingsPath), {keywords: ['活动'], useKeywordPrefix: true});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
