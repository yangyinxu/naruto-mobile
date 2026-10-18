import assert from 'node:assert/strict';
import test from 'node:test';
import {catalogFile} from '../../scripts/build-catalogs.mjs';

/** Windows checkouts with core.autocrlf=true hold CRLF files; their catalogs must match the LF result. */
const toCrlf = (text: string) => text.replace(/\n/g, '\r\n');
const occurrences = (text: string, marker: string) => text.split(marker).length - 1;

const codeSource = [
  "import path from 'node:path';",
  '',
  'export const answer = 42;',
  '',
  'export function describeAnswer() {',
  ...Array.from({length: 110}, (_, index) => `  console.log(${index});`),
  '}',
  '',
  'const separator = () => path.sep;',
  ''
].join('\n');

const markdownSource = [
  '# Guide',
  '',
  'Introduction.',
  '',
  '## Setup',
  '',
  ...Array.from({length: 60}, (_, index) => `Setup line ${index}.`),
  '',
  '### Windows',
  '',
  '```powershell',
  '## not a heading',
  '```',
  '',
  '## Usage',
  '',
  ...Array.from({length: 50}, (_, index) => `Usage line ${index}.`),
  ''
].join('\n');

const assertCrlfCatalog = (file: string, source: string, marker: string, addition: string) => {
  const expected = toCrlf(catalogFile(file, source).content);
  const generated = catalogFile(file, toCrlf(source)).content;
  assert.equal(generated, expected);
  assert.equal(occurrences(generated, marker), 1);
  assert.doesNotMatch(generated, /(^|[^\r])\n/);
  assert.equal(catalogFile(file, generated).content, generated);

  const edited = `${generated}${toCrlf(addition)}`;
  const refreshed = catalogFile(file, edited).content;
  assert.equal(refreshed, toCrlf(catalogFile(file, `${source}${addition}`).content));
  assert.equal(occurrences(refreshed, marker), 1);
};

test('catalogs a CRLF code file without throwing, duplicating, or changing its line endings', () => {
  assertCrlfCatalog('src/example.ts', codeSource, '/* @catalog', 'export const added = 1;\n');
});

test('catalogs a CRLF Markdown file without adding a second catalog block', () => {
  assertCrlfCatalog('docs/example.md', markdownSource, '<!-- @catalog -->', '\n## Added\n\nMore text.\n');
});

test('keeps LF files in LF', () => {
  const generated = catalogFile('src/example.ts', codeSource).content;
  assert.doesNotMatch(generated, /\r/);
  assert.equal(occurrences(generated, '/* @catalog'), 1);
  assert.equal(catalogFile('src/example.ts', generated).content, generated);
});
