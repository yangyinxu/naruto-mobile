import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadAppConfig} from '../src/config';

test('creates and reuses a private local UID salt when none is configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-config-'));
  const previousRoot = process.env.RESEARCH_DATA_DIR;
  const previousSalt = process.env.RESEARCH_UID_SALT;
  try {
    process.env.RESEARCH_DATA_DIR = directory;
    delete process.env.RESEARCH_UID_SALT;
    const first = loadAppConfig();
    const second = loadAppConfig();
    assert.equal(first.uidSalt, second.uidSalt);
    assert.match(first.uidSalt, /^[a-f0-9]{64}$/);
    assert.equal((await readFile(join(directory, '.uid-salt'), 'utf8')).trim(), first.uidSalt);
  } finally {
    if (previousRoot === undefined) delete process.env.RESEARCH_DATA_DIR;
    else process.env.RESEARCH_DATA_DIR = previousRoot;
    if (previousSalt === undefined) delete process.env.RESEARCH_UID_SALT;
    else process.env.RESEARCH_UID_SALT = previousSalt;
    await rm(directory, {recursive: true, force: true});
  }
});
