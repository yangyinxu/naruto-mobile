import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {readSavedDataRoot, saveDataRoot} from '../src/services/dataRootSettings';

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
