import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const candidate = join(projectRoot, 'build', 'windows', '火影调查.exe');
const releaseDirectory = join(projectRoot, 'release');
const published = join(releaseDirectory, '火影调查.exe');
const pending = join(releaseDirectory, `火影调查.${process.pid}.pending`);
const smokePath = join(projectRoot, 'build', 'windows', 'smoke', 'result.json');
const publishedSmoke = join(releaseDirectory, '火影调查.smoke.json');
const pendingSmoke = join(releaseDirectory, `火影调查.${process.pid}.smoke.pending`);
const digest = contents => createHash('sha256').update(contents).digest('hex');

// Publish only the exact package that passed the executable smoke test.
const contents = await readFile(candidate);
assert.ok(contents.length > 10_000_000 && contents.subarray(0, 2).toString('ascii') === 'MZ', 'Missing or invalid Windows package');
const sha256 = digest(contents);
const smokeContents = await readFile(smokePath);
const smoke = JSON.parse(smokeContents.toString('utf8'));
assert.equal(smoke.status, 'passed', 'Windows package has not passed its smoke test');
assert.equal(smoke.sha256, sha256, 'Smoke test does not match the Windows package');
assert.equal(smoke.filename, '火影调查.exe', 'Smoke test does not match the release filename');
await mkdir(releaseDirectory, {recursive: true});
try {
  await copyFile(candidate, pending);
  assert.equal(digest(await readFile(pending)), sha256, 'Windows package copy failed verification');
  await copyFile(smokePath, pendingSmoke);
  assert.deepEqual(await readFile(pendingSmoke), smokeContents, 'Smoke evidence copy failed verification');
  await rename(pending, published);
  await rename(pendingSmoke, publishedSmoke);
} finally {
  await rm(pending, {force: true});
  await rm(pendingSmoke, {force: true});
}
process.stdout.write(`${published}\nSHA256: ${sha256}\n`);
