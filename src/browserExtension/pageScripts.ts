export interface VisibleComment {
  text: string;
  authorUid?: string;
  authorName?: string;
  authorProfileUrl?: string;
  sourceRecordId?: string;
  parentSourceRecordId?: string;
  publishedAtText?: string;
  publishedAtEpochSeconds?: number;
  likes: number;
  replies: number;
  isReply: boolean;
}
export interface ContentSnapshot {
  title: string;
  description: string;
  publishedAt?: string;
  resolvedUrl: string;
  comments: VisibleComment[];
  commentState: 'loaded' | 'empty' | 'not_ready' | 'verification_required';
}

/** Runs in the tool's fixed nav page and returns only an allowlisted login summary. */
export function readLoginPage() {
  const text = (document.querySelector('pre')?.textContent || document.body.textContent || '').replace(/^\uFEFF/, '');
  if (text.length > 256_000) throw new Error('B站登录状态响应超过限制。');
  let value: {code?: number; data?: {isLogin?: boolean; uname?: string; mid?: number | string}};
  try { value = JSON.parse(text); } catch { throw new Error('B站登录状态暂时无法读取，请稍后重试。'); }
  if (value.code !== 0 || !value.data?.isLogin) return {loginState: 'logged_out' as const};
  if (typeof value.data.uname !== 'string' || value.data.uname.length > 200
    || !/^\d{1,32}$/.test(String(value.data.mid ?? ''))) throw new Error('B站登录状态格式不正确。');
  return {loginState: 'logged_in' as const, accountName: value.data.uname.trim() || '已登录用户',
    accountUidSuffix: String(value.data.mid).slice(-4)};
}

/** Reads public search links; the privileged worker validates every resulting URL. */
export function readSearchPage(type: 'video' | 'dynamic') {
  const selector = type === 'video' ? 'a[href*="/video/BV"]' : 'a[href*="/opus/"], a[href*="t.bilibili.com/"]';
  if (/^(?:安全验证|人机验证|验证码|访问验证|captcha|security verification)(?:\s*[-_|·].*)?$/i.test(document.title.trim())) {
    throw new Error('B站要求人工验证，请在自己的浏览器完成后重试。');
  }
  return Array.from(document.querySelectorAll<HTMLAnchorElement>(selector)).slice(0, 400).map((anchor) => ({
    href: anchor.href.slice(0, 16_384),
    title: (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    context: (anchor.closest('div')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  }));
}

/** Captures bounded visible DOM and open ShadowRoots without requesting private APIs. */
export async function readContentPage(): Promise<ContentSnapshot> {
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const clean = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() || undefined;
  const count = (value: string | undefined) => {
    const match = value?.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万亿]?)/);
    return match ? Math.round(Number(match[1]) * (match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1)) : 0;
  };
  const metadata = (selector: string) => document.querySelector(selector)?.getAttribute('content')?.trim().slice(0, 20_000) || '';
  const text = (root: ParentNode, selectors: string[]) => {
    for (const selector of selectors) {
      const value = clean(root.querySelector(selector)?.textContent);
      if (value) return value;
    }
    return undefined;
  };
  const attr = (elements: Array<Element | null | undefined>, names: string[]) => {
    for (const element of elements) for (const name of names) {
      const value = element?.getAttribute(name)?.trim();
      if (value) return value;
    }
    return undefined;
  };
  const platformId = (...values: unknown[]) => {
    const value = values.find((item) => (typeof item === 'string' || typeof item === 'number') && /^\d{1,32}$/.test(String(item)) && String(item) !== '0');
    return value === undefined ? undefined : String(value);
  };
  const comments = new Map<string, VisibleComment>();
  const visible = (element: Element) => {
    let current: Element | undefined = element;
    for (let depth = 0; current && depth < 40; depth += 1) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false;
      const style = document.defaultView?.getComputedStyle(current);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      const root = current.getRootNode();
      current = current.parentElement || ('host' in root ? (root as ShadowRoot).host : undefined);
    }
    return !current;
  };
  const verificationRequired = () => /^(?:安全验证|人机验证|验证码|访问验证|captcha|security verification)(?:\s*[-_|·].*)?$/i.test(document.title.trim())
    || Array.from(document.querySelectorAll('.geetest_panel, .geetest_panel_box, .bili-captcha, #bili-captcha')).some(visible);
  const noise = new Set(['置顶', '展开', '收起', '回复', '点赞', '按热度排序', '按时间排序']);
  const scan = () => {
    const roots: Array<Document | ShadowRoot> = [document];
    let elementsVisited = 0;
    const record = (body: string | undefined, scope: ParentNode, container: Element, isReply: boolean) => {
      if (!body || body.length < 3 || body.length > 1200 || noise.has(body) || comments.size >= 80) return;
      // MAIN-world execution can read Bilibili's public component backing data.
      const data = (container as Element & {__data?: Record<string, unknown>}).__data || {};
      const member = data.member && typeof data.member === 'object' ? data.member as Record<string, unknown> : {};
      const profile = scope.querySelector<HTMLAnchorElement>('a[href*="space.bilibili.com/"]');
      const profileElement = scope.querySelector<HTMLElement>('[data-user-profile-id]');
      const authorUid = platformId(member.mid, data.mid_str, data.mid, profileElement?.dataset.userProfileId,
        attr([profileElement, container], ['data-user-profile-id', 'data-mid', 'data-uid']), profile?.href.match(/space\.bilibili\.com\/(\d+)/)?.[1]);
      const sourceRecordId = platformId(data.rpid_str, data.rpid, attr([container, scope.querySelector('[data-rpid]')], ['data-rpid', 'data-reply-id', 'rpid', 'reply-id']));
      const parentSourceRecordId = platformId(data.parent_str, data.parent, data.root_str, data.root,
        attr([container, scope.querySelector('[data-parent-id]')], ['data-root-id', 'data-root', 'data-parent-id', 'data-parent', 'root-id', 'parent-id']));
      const authorName = (clean(typeof member.uname === 'string' ? member.uname : undefined)
        || text(scope, ['#user-name', '.user-name', '.sub-user-name', '.name', '[class*="username"]']))?.slice(0, 200);
      const key = `${sourceRecordId || ''}\0${authorUid || authorName || 'anonymous'}\0${body}`;
      const control = data.reply_control && typeof data.reply_control === 'object' ? data.reply_control as Record<string, unknown> : {};
      const epoch = Number(data.ctime);
      comments.set(key, {text: body, authorUid, authorName,
        ...(authorUid ? {authorProfileUrl: `https://space.bilibili.com/${authorUid}`} : {}),
        sourceRecordId, parentSourceRecordId,
        publishedAtText: (clean(typeof control.time_desc === 'string' ? control.time_desc : undefined)
          || text(scope, ['time', '#pubdate', '.pubdate', '.reply-time', '.sub-reply-time']))?.slice(0, 100),
        ...(Number.isFinite(epoch) && epoch > 0 && epoch < 10_000_000_000 ? {publishedAtEpochSeconds: epoch} : {}),
        likes: count(data.like === undefined ? text(scope, ['#like', '.like', '[class*="like"]']) : String(data.like)),
        replies: count(data.rcount === undefined && data.count === undefined
          ? text(scope, ['#reply', '.reply-count', '[class*="reply-count"]']) : String(data.rcount ?? data.count)),
        isReply: isReply || Boolean(parentSourceRecordId && parentSourceRecordId !== sourceRecordId)});
    };
    for (let index = 0; index < roots.length && index < 300 && elementsVisited < 20_000; index += 1) {
      const root = roots[index];
      for (const element of Array.from(root.querySelectorAll('*'))) {
        elementsVisited += 1;
        if (elementsVisited >= 20_000) break;
        if (element.shadowRoot && roots.length < 300) roots.push(element.shadowRoot);
      }
      if ('host' in root && root.host.tagName === 'BILI-RICH-TEXT') {
        const parent = root.host.getRootNode();
        if ('host' in parent) {
          const parentRoot = parent as ShadowRoot;
          record(clean(root.querySelector('#contents')?.textContent), parentRoot, parentRoot.host,
            parentRoot.host.tagName.toLowerCase().includes('reply'));
        }
      }
      for (const container of Array.from(root.querySelectorAll('.reply-item, .sub-reply-item, .reply-wrap, .comment-list .list-item'))) {
        record(text(container, ['.reply-content', '.sub-reply-content', '.text']), container, container, container.matches('.sub-reply-item'));
      }
    }
    return roots;
  };
  // Bilibili mounts the comment element lazily, often after the first scroll.
  // Reacquire it on every pass and keep incomplete reads retryable at the worker.
  const deadline = Date.now() + 9000;
  let commentState: ContentSnapshot['commentState'] = 'not_ready';
  let previousCount = 0;
  let stableRounds = 0;
  let expanded = 0;
  const clicked = new WeakSet<Element>();
  for (let round = 0; round < 24; round += 1) {
    if (verificationRequired()) { commentState = 'verification_required'; break; }
    const roots = scan();
    if (comments.size > 0) {
      commentState = 'loaded';
      stableRounds = comments.size === previousCount ? stableRounds + 1 : 0;
      previousCount = comments.size;
      if (comments.size >= 80 || stableRounds >= 3) break;
    }
    // The platform observes the custom element itself, not its outer placeholder.
    const area = document.querySelector('bili-comments') || document.querySelector('#commentapp, .comment-container, #comment');
    if (!comments.size) {
      // An unmounted/blank placeholder is not evidence that a source has no comments.
      const emptyRoots: ParentNode[] = area ? [area] : [];
      for (const root of roots) if ('host' in root && (root.host.tagName === 'BILI-COMMENTS'
        || root.host.tagName === 'BILI-COMMENTS-EMPTY' || area?.contains(root.host))) emptyRoots.push(root);
      const empty = emptyRoots.some((root) => Array.from(root.querySelectorAll(
        '.reply-empty, .comment-empty, .empty-state, .no-comment, #empty, bili-comments-empty, p, span'
      )).some((element) => visible(element) && /^(?:暂无评论[，,。！!\s]*|还没有评论[，,。！!\s]*|评论(?:区)?已关闭[。！!\s]*|快来(?:发|抢)[第首]?(?:一条评论|沙发)[。！!\s]*)$/.test(clean(element.textContent) || '')));
      // A terminal footer also appears after nonempty lists; pair it with this list's visible zero-count header.
      const terminalEmpty = roots.some((root) => {
        if (!('host' in root) || root.host.tagName !== 'BILI-COMMENTS') return false;
        const footer = root.querySelector('#end .bottombar');
        if (!footer || !visible(footer) || clean(footer.textContent) !== '没有更多评论') return false;
        return Array.from(root.querySelectorAll('bili-comments-header-renderer')).some((header) => {
          const title = header.shadowRoot?.querySelector('#title > h2');
          const total = header.shadowRoot?.querySelector('#title > #count');
          return Boolean(title && total && visible(title) && visible(total)
            && clean(title.textContent) === '评论' && clean(total.textContent) === '0');
        });
      });
      if (empty || terminalEmpty) { commentState = 'empty'; break; }
    }
    let expandedThisRound = false;
    for (const root of roots) {
      for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
        if (expanded >= 5) break;
        if (!clicked.has(button) && visible(button) && /^(展开|查看更多).{0,12}(回复|条)/.test(clean(button.textContent) || '')) {
          button.click(); clicked.add(button); expanded += 1; expandedThisRound = true;
        }
      }
    }
    if (expandedThisRound) stableRounds = 0;
    if (Date.now() >= deadline) break;
    if (area) area.scrollIntoView?.({block: comments.size ? 'end' : 'start', behavior: 'instant'});
    else document.documentElement.scrollIntoView?.({block: 'end', behavior: 'instant'});
    await wait(Math.min(400, Math.max(0, deadline - Date.now())));
  }
  return {
    title: (metadata('meta[property="og:title"]') || document.title).replace(/_(?:游戏热门视频|哔哩哔哩.*)$/i, '').trim().slice(0, 2000),
    description: metadata('meta[property="og:description"]'),
    publishedAt: metadata('meta[itemprop="datePublished"]') || metadata('meta[property="article:published_time"]') || undefined,
    resolvedUrl: location.href,
    comments: [...comments.values()].slice(0, 80),
    commentState
  };
}
