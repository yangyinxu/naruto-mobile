import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadAppConfig, resolveEnvFileCandidates} from '../src/config';

test('portable build checks beside the launcher and its parent for .env', () => {
  assert.deepEqual(resolveEnvFileCandidates('C:\\unrelated', {
    PORTABLE_EXECUTABLE_DIR: 'D:\\apps\\naruto\\release'
  }), [
    'C:\\unrelated\\.env',
    'D:\\apps\\naruto\\release\\.env',
    'D:\\apps\\naruto\\.env'
  ]);
});

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

test('defaults AI requests to twelve while retaining bounded explicit concurrency', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naruto-mobile-ai-capacity-'));
  const previous = {root: process.env.RESEARCH_DATA_DIR, concurrency: process.env.OPENAI_CONCURRENCY};
  try {
    process.env.RESEARCH_DATA_DIR = directory;
    delete process.env.OPENAI_CONCURRENCY;
    assert.equal(loadAppConfig().aiConcurrency, 12);
    process.env.OPENAI_CONCURRENCY = '4';
    assert.equal(loadAppConfig().aiConcurrency, 4);
    process.env.OPENAI_CONCURRENCY = '999';
    assert.equal(loadAppConfig().aiConcurrency, 12);
    process.env.OPENAI_CONCURRENCY = '0';
    assert.equal(loadAppConfig().aiConcurrency, 12);
  } finally {
    if (previous.root === undefined) delete process.env.RESEARCH_DATA_DIR;
    else process.env.RESEARCH_DATA_DIR = previous.root;
    if (previous.concurrency === undefined) delete process.env.OPENAI_CONCURRENCY;
    else process.env.OPENAI_CONCURRENCY = previous.concurrency;
    await rm(directory, {recursive: true, force: true});
  }
});
