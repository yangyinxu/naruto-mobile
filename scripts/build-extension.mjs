import {build} from 'esbuild';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipFile} from 'yazl';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'build', 'chrome-extension');
const hostedArchive = join(root, 'web', 'hosted-dist', 'naruto-mobile-chrome-extension.zip');
await mkdir(output, {recursive: true});
await build({
  entryPoints: {background: join(root, 'src', 'browserExtension', 'background.ts'), portal: join(root, 'src', 'browserExtension', 'portal.ts')},
  outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome120',
  // Chrome serializes injected functions; do not introduce external naming helpers.
  keepNames: false, sourcemap: false, legalComments: 'none'
});
const manifest = await readFile(join(root, 'extension', 'manifest.json'));
await writeFile(join(output, 'manifest.json'), manifest);
const zip = new ZipFile();
for (const name of ['manifest.json', 'background.js', 'portal.js']) zip.addBuffer(await readFile(join(output, name)), name);
const chunks = [];
const archive = new Promise((resolveArchive, reject) => {
  zip.outputStream.on('data', (chunk) => chunks.push(chunk));
  zip.outputStream.once('error', reject);
  zip.outputStream.once('end', () => resolveArchive(Buffer.concat(chunks)));
});
zip.end();
const contents = await archive;
// The hosted copy keeps Archtree's fixed URL; the local artifact carries the version in its name.
const {version} = JSON.parse(manifest.toString('utf8'));
const localArchive = join(root, 'build', `naruto-mobile-chrome-extension-${version}.zip`);
await writeFile(localArchive, contents);
await mkdir(dirname(hostedArchive), {recursive: true});
await writeFile(hostedArchive, contents);
console.log(`Extension: ${output}`);
console.log(`Extension ZIP: ${localArchive}`);
console.log(`Hosted download: ${hostedArchive}`);
