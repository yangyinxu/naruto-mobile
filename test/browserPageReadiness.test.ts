import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import type {ContentSnapshot} from '../src/browserExtension/pageScripts';

const require = createRequire(import.meta.url);
const {JSDOM} = require('jsdom') as {JSDOM: new (html: string, options: {url: string}) => {window: Window & typeof globalThis}};
const bundle = build({stdin: {contents: `export {readContentPage, readSearchPage} from './src/browserExtension/pageScripts';`, resolveDir: resolve('.')},
  bundle: true, platform: 'browser', format: 'iife', globalName: 'readers', write: false, target: 'chrome120', keepNames: false})
  .then((result) => result.outputFiles![0].text);

/** Virtual time exercises the full production deadline without sleeping or changing its bounds. */
async function fixture(html: string, onPoll?: (now: number, doc: Document) => void) {
  const dom = new JSDOM(html, {url: 'https://www.bilibili.com/video/BVReadiness'});
  let elapsed = 0;
  let scrolls = 0;
  const scrollTargets: string[] = [];
  Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', {value(this: Element) { scrolls += 1; scrollTargets.push(this.tagName); }});
  const context = {document: dom.window.document, location: dom.window.location,
    Date: class extends Date {static now() { return elapsed; }},
    setTimeout(callback: () => void, ms: number) {
      elapsed += ms;
      onPoll?.(elapsed, dom.window.document);
      queueMicrotask(callback);
      return 1;
    }, readers: undefined as unknown as {readContentPage: () => Promise<ContentSnapshot>; readSearchPage: (type: string) => unknown}};
  runInNewContext(await bundle, context);
  return {doc: dom.window.document, read: context.readers.readContentPage, search: context.readers.readSearchPage,
    elapsed: () => elapsed, scrolls: () => scrolls, scrollTargets: () => scrollTargets, close: () => dom.window.close()};
}

/** Mirrors Bilibili's open comment components, not a preloaded legacy comment list. */
function appendComment(doc: Document) {
  const area = doc.querySelector('#commentapp')!;
  const list = doc.createElement('bili-comments');
  area.append(list);
  const renderer = doc.createElement('bili-comment-renderer');
  list.attachShadow({mode: 'open'}).append(renderer);
  const rich = doc.createElement('bili-rich-text');
  renderer.attachShadow({mode: 'open'}).append(rich);
  rich.attachShadow({mode: 'open'}).innerHTML = '<span id="contents">技能后摇太长，无法反打</span>';
}

/** The current public component uses a terminal footer even when its count is zero. */
function appendTerminalList(doc: Document, count: string | undefined = '0') {
  const list = doc.createElement('bili-comments');
  doc.querySelector('#commentapp')!.append(list);
  const root = list.attachShadow({mode: 'open'});
  root.innerHTML = '<div id="end"><div class="bottombar">没有更多评论</div></div>';
  const header = doc.createElement('bili-comments-header-renderer');
  root.prepend(header);
  header.attachShadow({mode: 'open'}).innerHTML = `<div id="title"><h2>评论</h2>${count === undefined ? '' : `<div id="count">${count}</div>`}</div>`;
  return {list, root, header, footer: root.querySelector<HTMLElement>('#end .bottombar')!,
    count: header.shadowRoot!.querySelector<HTMLElement>('#count')};
}

test('the visible terminal footer plus zero count in the same comment header confirms an empty source', async () => {
  const value = await fixture('<div id="commentapp"></div>');
  try {
    appendTerminalList(value.doc);
    const result = await value.read();
    assert.equal(result.commentState, 'empty');
    assert.equal(result.comments.length, 0);
    assert.equal(value.elapsed(), 0);
  } finally {value.close();}
});

test('a terminal footer alone or a nonzero, missing, hidden or unrelated count remains retryable', async () => {
  const cases = ['footer_only', 'positive', 'missing', 'not_exact_zero', 'hidden_footer', 'hidden_count', 'hidden_header',
    'hidden_list', 'wrong_component', 'different_list', 'nonterminal_footer', 'wrong_title'] as const;
  for (const scenario of cases) {
    const value = await fixture('<div id="commentapp"></div>');
    try {
      const list = appendTerminalList(value.doc, scenario === 'positive' ? '3' : scenario === 'not_exact_zero' ? '00' : '0');
      if (scenario === 'missing') list.count!.remove();
      if (scenario === 'footer_only') list.header.remove();
      if (scenario === 'hidden_footer') list.footer.style.display = 'none';
      if (scenario === 'hidden_count') list.count!.style.visibility = 'hidden';
      if (scenario === 'hidden_header') list.header.setAttribute('hidden', '');
      if (scenario === 'hidden_list') list.list.setAttribute('aria-hidden', 'true');
      if (scenario === 'wrong_component') {
        list.header.remove();
        const other = value.doc.createElement('bili-comment-action-buttons-renderer');
        list.root.append(other);
        other.attachShadow({mode: 'open'}).innerHTML = '<div id="title"><h2>评论</h2><div id="count">0</div></div>';
      }
      if (scenario === 'different_list') {
        list.header.remove();
        appendTerminalList(value.doc).footer.remove();
      }
      if (scenario === 'nonterminal_footer') list.footer.textContent = '查看更多评论';
      if (scenario === 'wrong_title') list.header.shadowRoot!.querySelector('h2')!.textContent = '点赞';
      const result = await value.read();
      assert.equal(result.commentState, 'not_ready', scenario);
      assert.equal(value.elapsed(), 9000, scenario);
    } finally {value.close();}
  }
});

test('loaded comments take precedence over a rendered zero count and terminal footer', async () => {
  const value = await fixture('<div id="commentapp"></div>');
  try {
    const list = appendTerminalList(value.doc);
    const renderer = value.doc.createElement('bili-comment-renderer');
    list.root.append(renderer);
    const rich = value.doc.createElement('bili-rich-text');
    renderer.attachShadow({mode: 'open'}).append(rich);
    rich.attachShadow({mode: 'open'}).innerHTML = '<span id="contents">有效的公开评论内容</span>';
    const result = await value.read();
    assert.equal(result.commentState, 'loaded');
    assert.equal(result.comments.length, 1);
  } finally {value.close();}
});

test('reacquires a late comment container, scrolls again, and waits past the old fixed delay', async () => {
  let appended = false;
  const value = await fixture('<title>新忍者机制验证_哔哩哔哩</title>', (now, doc) => {
    if (now >= 2800 && !doc.querySelector('#commentapp')) doc.body.insertAdjacentHTML('beforeend', '<div id="commentapp"></div>');
    if (now >= 4400 && !appended) { appendComment(doc); appended = true; }
  });
  try {
    const result = await value.read();
    assert.equal(result.commentState, 'loaded');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].text, '技能后摇太长，无法反打');
    assert.ok(value.elapsed() >= 4400);
    assert.ok(value.elapsed() <= 9000);
    assert.ok(value.scrolls() >= 10);
    assert.equal(result.title, '新忍者机制验证');
  } finally { value.close(); }
});

test('a blank or absent comment placeholder times out as retryable, never empty', async () => {
  for (const html of ['<title>Video</title>', '<title>Video</title><div id="commentapp"><span>评论加载中</span></div>']) {
    const value = await fixture(html);
    try {
      const result = await value.read();
      assert.equal(result.commentState, 'not_ready');
      assert.equal(result.comments.length, 0);
      assert.equal(value.elapsed(), 9000);
    } finally { value.close(); }
  }
});

test('scrolls the actual observed comment host before its wrapping placeholder', async () => {
  const value = await fixture('<div id="commentapp"></div>');
  try {
    appendComment(value.doc);
    assert.equal((await value.read()).commentState, 'loaded');
    assert.equal(value.scrollTargets()[0], 'BILI-COMMENTS');
    assert.ok(value.scrollTargets().every((tag) => tag === 'BILI-COMMENTS'));
  } finally { value.close(); }
});

test('explicit rendered empty state is accepted but a hidden empty banner is ignored', async () => {
  const empty = await fixture('<div id="commentapp"><p class="reply-empty">暂无评论</p></div>');
  try { assert.equal((await empty.read()).commentState, 'empty'); } finally { empty.close(); }
  const hidden = await fixture('<div id="commentapp"><div style="display:none"><p>暂无评论</p></div></div>', (now, doc) => {
    if (now === 1600) appendComment(doc);
  });
  try { assert.equal((await hidden.read()).commentState, 'loaded'); } finally { hidden.close(); }
});

test('visible verification stops collection while hidden controls and ordinary verification titles do not', async () => {
  for (const html of ['<title>安全验证 - 哔哩哔哩</title>', '<div class="geetest_panel">请完成验证</div>']) {
    const value = await fixture(html);
    try {
      assert.equal((await value.read()).commentState, 'verification_required');
      assert.equal(value.scrolls(), 0);
    } finally { value.close(); }
  }
  const normal = await fixture('<title>新忍者机制验证</title><div style="display:none"><div class="geetest_panel_box"></div></div><div id="commentapp"></div>');
  try {
    appendComment(normal.doc);
    assert.equal((await normal.read()).commentState, 'loaded');
    assert.doesNotThrow(() => normal.search('video'));
  } finally { normal.close(); }
});
