import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/** Enforces the placement and dependency rules in docs/architecture-standards.md. */
const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('tests live in a folder named after a src area, platform, or fixtures', () => {
  const areas = readdirSync(path.join(repositoryRoot, 'src'), {withFileTypes: true})
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const allowed = new Set([...areas, 'platform', 'fixtures']);
  const misplaced = readdirSync(path.join(repositoryRoot, 'test'), {withFileTypes: true})
    .filter(entry => !entry.isDirectory() || !allowed.has(entry.name))
    .map(entry => entry.name);
  assert.deepEqual(misplaced, []);
});

test('domain modules import no other source area', () => {
  const domain = path.join(repositoryRoot, 'src/domain');
  const violations = readdirSync(domain).filter(name => name.endsWith('.ts')).flatMap(name =>
    [...readFileSync(path.join(domain, name), 'utf8').matchAll(/from '(\.\.\/[^']+)'/g)]
      .map(match => `${name} -> ${match[1]}`));
  assert.deepEqual(violations, []);
});
