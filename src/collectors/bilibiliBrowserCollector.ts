import {Page} from 'playwright';
import {AppConfig} from '../config';
import {ChromeConnectionService} from '../services/chromeConnection';
import {
  CandidateContent,
  CollectionContext,
  CollectionResult,
  Collector,
  ContentRecord,
  ContentType,
  OpinionRecord
} from '../domain/types';
import {contentIdFromUrl, delay, normalizedUrl, stableId} from './collectorUtils';

const searchUrls = (
  keyword: string,
  includeVideos: boolean,
  includeDynamics: boolean,
  contentWindowDays: number
) => {
  const encoded = encodeURIComponent(keyword);
  const endSeconds = Math.floor(Date.now() / 1000);
  const beginSeconds = endSeconds - contentWindowDays * 86400;
  const timeFilter = `&pubtime_begin_s=${beginSeconds}&pubtime_end_s=${endSeconds}`;
  const urls: Array<{type: ContentType; url: string}> = [];
  if (includeVideos) urls.push({type: 'video', url: `https://search.bilibili.com/video?keyword=${encoded}&order=click${timeFilter}`});
  if (includeDynamics) urls.push({type: 'dynamic', url: `https://search.bilibili.com/dynamic?keyword=${encoded}${timeFilter}`});
  return urls;
};

const discoveredDate = (text: string) => {
  const fullDate = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (fullDate) {
    const parsed = new Date(Date.UTC(Number(fullDate[1]), Number(fullDate[2]) - 1, Number(fullDate[3])));
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const shortDate = text.match(/(?:^|\s)(\d{1,2})[-/.](\d{1,2})(?:\s|$)/);
  if (shortDate) {
    const now = new Date();
    let year = now.getUTCFullYear();
    let parsed = new Date(Date.UTC(year, Number(shortDate[1]) - 1, Number(shortDate[2])));
    if (parsed.getTime() > now.getTime() + 86400000) {
      year -= 1;
      parsed = new Date(Date.UTC(year, Number(shortDate[1]) - 1, Number(shortDate[2])));
    }
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
};

const outcomeForDirective = (
  directive: ReturnType<CollectionContext['callbacks']['getDirective']>
): CollectionResult['outcome'] | null => {
  if (directive === 'pause') return 'paused';
  if (directive === 'finalize') return 'finalized';
  if (directive === 'budget_exhausted') return 'budget_exhausted';
  return null;
};

const metadata = async (page: Page, selector: string, attribute = 'content') => {
  try {
    return (await page.locator(selector).first().getAttribute(attribute))?.trim() || '';
  } catch {
    return '';
  }
};

interface CollectedComment {
  text: string;
  authorUid?: string;
  authorName?: string;
  authorProfileUrl?: string;
  sourceRecordId?: string;
  parentSourceRecordId?: string;
  sourceUrl?: string;
  publishedAtText?: string;
  publishedAtEpochSeconds?: number;
  likes: number;
  replies: number;
  isReply: boolean;
}

const publicProfileUrl = (uid?: string, href?: string) => {
  if (href) {
    try {
      return new URL(href, 'https://www.bilibili.com').toString();
    } catch {
      // Fall through to the stable UID URL.
    }
  }
  return uid ? `https://space.bilibili.com/${uid}` : undefined;
};

const commentSourceUrl = (
  pageUrl: string,
  sourceRecordId?: string,
  parentSourceRecordId?: string,
  discoveredUrl?: string
) => {
  if (discoveredUrl) {
    try {
      return new URL(discoveredUrl, pageUrl).toString();
    } catch {
      // Build a traceable URL from the public record identifiers instead.
    }
  }
  if (!sourceRecordId) return pageUrl;
  try {
    const url = new URL(pageUrl);
    url.searchParams.set('comment_on', '1');
    url.searchParams.set('comment_root_id', parentSourceRecordId || sourceRecordId);
    if (parentSourceRecordId && parentSourceRecordId !== sourceRecordId) {
      url.searchParams.set('comment_secondary_id', sourceRecordId);
    }
    return url.toString();
  } catch {
    return pageUrl;
  }
};

const parseVisibleCount = (value: string | undefined) => {
  const text = value?.replace(/,/g, '').trim();
  if (!text) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)\s*([万亿]?)/);
  if (!match) return 0;
  const multiplier = match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
};

const parsedCommentTime = (value: string | undefined, collectedAt: string) => {
  const text = value?.trim();
  if (!text) return undefined;
  const base = new Date(collectedAt);
  const relative = text.match(/(\d+)\s*(秒|分钟|小时|天)前/);
  if (relative) {
    const unitMs = relative[2] === '天' ? 86_400_000
      : relative[2] === '小时' ? 3_600_000
        : relative[2] === '分钟' ? 60_000 : 1_000;
    return new Date(base.getTime() - Number(relative[1]) * unitMs).toISOString();
  }
  if (/刚刚/.test(text)) return base.toISOString();
  const full = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (full) {
    const parsed = new Date(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4] ?? 0),
      Number(full[5] ?? 0)
    );
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const short = text.match(/(?:^|\s)(\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (short) {
    let year = base.getFullYear();
    let parsed = new Date(year, Number(short[1]) - 1, Number(short[2]), Number(short[3] ?? 0), Number(short[4] ?? 0));
    if (parsed.getTime() > base.getTime() + 86_400_000) {
      year -= 1;
      parsed = new Date(year, Number(short[1]) - 1, Number(short[2]), Number(short[3] ?? 0), Number(short[4] ?? 0));
    }
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
};

const collectComments = async (page: Page) => {
  await page.evaluate(() => {
    const area = document.querySelector('#commentapp, bili-comments, .comment-container');
    (area ?? document.body).scrollIntoView({block: area ? 'start' : 'end'});
  });
  await delay(1200);
  // Playwright serializes the next function into the page. tsx may wrap that
  // function itself with the esbuild __name helper, so install the tiny helper
  // in the page before serialization executes.
  await page.evaluate('globalThis.__name = (target) => target');
  const items = await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    const values: Array<{
      text: string;
      authorUid?: string;
      authorName?: string;
      authorProfileUrl?: string;
      sourceRecordId?: string;
      parentSourceRecordId?: string;
      sourceUrl?: string;
      publishedAtText?: string;
      publishedAtEpochSeconds?: number;
      likesText?: string;
      repliesText?: string;
      isReply: boolean;
    }> = [];
    const clean = (value: string | null | undefined) => value?.replace(/\s+/g, ' ').trim() || undefined;
    const attribute = (elements: Array<Element | null | undefined>, names: string[]) => {
      for (const element of elements) {
        if (!element) continue;
        for (const name of names) {
          const value = element.getAttribute(name)?.trim();
          if (value) return value;
        }
      }
      return undefined;
    };
    const uidFromProfile = (href?: string) => href?.match(/space\.bilibili\.com\/(\d+)/)?.[1];
    const queryText = (root: Document | ShadowRoot | Element, selectors: string[]) => {
      for (const selector of selectors) {
        const value = clean(root.querySelector(selector)?.textContent);
        if (value) return value;
      }
      return undefined;
    };
    const queryHref = (root: Document | ShadowRoot | Element, selectors: string[]) => {
      for (const selector of selectors) {
        const element = root.querySelector<HTMLAnchorElement>(selector);
        const value = element?.getAttribute('href')?.trim();
        if (value) return value;
      }
      return undefined;
    };
    const recordFrom = (
      text: string,
      scope: Document | ShadowRoot | Element,
      container?: Element,
      isReply = false
    ) => {
      const componentData = (container as HTMLElement & {__data?: {
        rpid?: number;
        rpid_str?: string;
        mid?: number;
        mid_str?: string;
        root?: number;
        root_str?: string;
        parent?: number;
        parent_str?: string;
        ctime?: number;
        like?: number;
        rcount?: number;
        count?: number;
        member?: {mid?: string; uname?: string};
        reply_control?: {time_desc?: string};
      }}).__data;
      const platformId = (...values: Array<string | number | undefined>) => {
        const value = values.find((item) => item !== undefined && String(item) !== '' && String(item) !== '0');
        return value === undefined ? undefined : String(value);
      };
      const profileElement = scope.querySelector<HTMLElement>('[data-user-profile-id]');
      const authorProfileUrl = queryHref(scope, [
        'a[href*="space.bilibili.com/"]',
        'a.user-name',
        'a.name'
      ]);
      const authorUid = platformId(componentData?.member?.mid, componentData?.mid_str, componentData?.mid)
        || profileElement?.dataset.userProfileId
        || attribute([profileElement, container], ['data-user-profile-id', 'data-mid', 'data-uid', 'mid', 'uid'])
        || uidFromProfile(authorProfileUrl);
      const sourceRecordId = platformId(componentData?.rpid_str, componentData?.rpid) || attribute([
        container,
        scope.querySelector('[data-rpid]'),
        scope.querySelector('[data-id]')
      ], ['data-rpid', 'data-reply-id', 'data-id', 'rpid', 'reply-id']);
      const parentSourceRecordId = platformId(
        componentData?.parent_str,
        componentData?.parent,
        componentData?.root_str,
        componentData?.root
      ) || attribute([
        container,
        scope.querySelector('[data-root-id]'),
        scope.querySelector('[data-parent-id]')
      ], ['data-root-id', 'data-root', 'data-parent-id', 'data-parent', 'root-id', 'parent-id']);
      values.push({
        text,
        authorUid,
        authorName: clean(componentData?.member?.uname) || queryText(scope, [
          '#user-name', '.user-name', '.sub-user-name', '.name',
          '[class*="user-name"]', '[class*="username"]'
        ]),
        authorProfileUrl,
        sourceRecordId,
        parentSourceRecordId,
        sourceUrl: queryHref(scope, [
          'a[href*="comment_root_id"]',
          'a[href*="comment_secondary_id"]',
          'a[href*="#reply"]'
        ]),
        publishedAtText: clean(componentData?.reply_control?.time_desc) || queryText(scope, [
          'time', '#pubdate', '.pubdate', '.reply-time', '.sub-reply-time', '[class*="time"]'
        ]),
        publishedAtEpochSeconds: componentData?.ctime,
        likesText: componentData?.like === undefined
          ? queryText(scope, ['#like', '.like', '[class*="like"]'])
          : String(componentData.like),
        repliesText: componentData?.rcount === undefined && componentData?.count === undefined
          ? queryText(scope, ['#reply', '.reply-count', '[class*="reply-count"]'])
          : String(componentData.rcount ?? componentData.count),
        isReply: isReply || Boolean(parentSourceRecordId && parentSourceRecordId !== sourceRecordId)
      });
    };
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      root.querySelectorAll('*').forEach((element) => {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      });
      if (root instanceof ShadowRoot && root.host.tagName === 'BILI-RICH-TEXT') {
        const element = root.querySelector('#contents');
        const text = clean(element?.textContent);
        const parentRoot = root.host.getRootNode();
        if (text && parentRoot instanceof ShadowRoot) {
          const container = parentRoot.host;
          const tag = container.tagName.toLowerCase();
          recordFrom(text, parentRoot, container, tag.includes('reply') && !tag.includes('comment-renderer'));
        }
      }
      root.querySelectorAll('.reply-item, .sub-reply-item, .reply-wrap, .comment-list .list-item').forEach((container) => {
        const text = queryText(container, ['.reply-content', '.sub-reply-content', '.text']);
        if (text) recordFrom(text, container, container, container.matches('.sub-reply-item'));
      });
    }
    return values;
  });
  const interfaceNoise = new Set(['置顶', '展开', '收起', '回复', '点赞', '按热度排序', '按时间排序']);
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourceRecordId ?? ''}\0${item.authorUid ?? item.authorName ?? 'anonymous'}\0${item.text}`;
    if (item.text.length < 3 || item.text.length > 1200 || interfaceNoise.has(item.text) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80).map((item): CollectedComment => ({
    text: item.text,
    authorUid: item.authorUid,
    authorName: item.authorName,
    authorProfileUrl: publicProfileUrl(item.authorUid, item.authorProfileUrl),
    sourceRecordId: item.sourceRecordId,
    parentSourceRecordId: item.parentSourceRecordId,
    sourceUrl: item.sourceUrl,
    publishedAtText: item.publishedAtText,
    publishedAtEpochSeconds: item.publishedAtEpochSeconds,
    likes: parseVisibleCount(item.likesText),
    replies: parseVisibleCount(item.repliesText),
    isReply: item.isReply
  }));
};

/** Uses only visible public Bilibili pages and never bypasses login or access controls. */
export class BilibiliBrowserCollector implements Collector {
  constructor(
    private readonly config: AppConfig,
    private readonly chromeConnection: ChromeConnectionService
  ) {}

  private async discover(page: Page, context: CollectionContext) {
    const {request} = context.manifest;
    const candidates: CandidateContent[] = [];
    let rank = 0;
    for (const keyword of request.keywords) {
      for (const target of searchUrls(keyword, request.includeVideos, request.includeDynamics, request.contentWindowDays)) {
        if (context.callbacks.getDirective() !== 'continue' || context.callbacks.remainingMs() < 20_000) break;
        try {
          await page.goto(target.url, {waitUntil: 'domcontentloaded', timeout: 20_000});
          await delay(800);
          const selector = target.type === 'video'
            ? 'a[href*="/video/BV"]'
            : 'a[href*="/opus/"], a[href*="t.bilibili.com/"]';
          const links = await page.locator(selector).evaluateAll((anchors) => anchors.map((anchor) => {
            const element = anchor as HTMLAnchorElement;
            const container = element.closest('div');
            return {
              href: element.href,
              title: element.getAttribute('title') || element.textContent || '',
              context: container?.textContent?.slice(0, 300) || ''
            };
          }));
          for (const link of links) {
            const url = normalizedUrl(link.href);
            const id = contentIdFromUrl(url, target.type);
            if (candidates.some((item) => item.id === id) || context.checkpoint.seenContentIds.includes(id)) continue;
            const publishedAt = discoveredDate(link.context);
            const cutoff = Date.now() - request.contentWindowDays * 86400000;
            if (publishedAt && new Date(publishedAt).getTime() < cutoff) continue;
            rank += 1;
            candidates.push({
              id,
              type: target.type,
              url,
              discoveryUrl: target.url,
              title: link.title.replace(/\s+/g, ' ').trim() || `${target.type === 'video' ? '视频' : '动态'} ${id}`,
              discoveryKeyword: keyword,
              discoveryRank: rank,
              popularityText: link.context.replace(/\s+/g, ' ').trim(),
              publishedAt
            });
            if (candidates.length >= request.maxSources) return candidates;
          }
        } catch (error) {
          await context.callbacks.onWarning('某个 B站搜索页面暂时无法读取，已继续其他来源。', {
            url: target.url,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    return candidates;
  }

  private async collectCandidate(page: Page, candidate: CandidateContent, runId: string): Promise<{
    content: ContentRecord;
    opinions: OpinionRecord[];
  }> {
    await page.goto(candidate.url, {waitUntil: 'domcontentloaded', timeout: 20_000});
    await delay(700);
    const collectedAt = new Date().toISOString();
    const pageTitle = ((await metadata(page, 'meta[property="og:title"]'))
      || (await page.title()).replace(/_哔哩哔哩.*$/, '').trim()
      || candidate.title).replace(/_(?:游戏热门视频|哔哩哔哩.*)$/i, '').trim();
    const description = await metadata(page, 'meta[property="og:description"]');
    const publishedAt = (await metadata(page, 'meta[itemprop="datePublished"]'))
      || (await metadata(page, 'meta[property="article:published_time"]'))
      || candidate.publishedAt
      || undefined;
    const content: ContentRecord = {
      ...candidate,
      runId,
      title: pageTitle,
      resolvedUrl: page.url(),
      description,
      publishedAt,
      collectedAt,
      metrics: {}
    };
    const opinions: OpinionRecord[] = [{
      id: stableId(candidate.id, 'creator', pageTitle),
      runId,
      contentId: candidate.id,
      contentType: candidate.type,
      sourceType: 'creator_view',
      voiceType: 'creator',
      text: pageTitle,
      publishedAt,
      collectedAt,
      likes: 0,
      replies: 0,
      sourcePageUrl: candidate.url,
      sourceUrl: candidate.url
    }];
    const comments = await collectComments(page);
    comments.forEach((item) => {
      const authorHash = item.authorUid ? stableId(this.config.uidSalt, item.authorUid) : undefined;
      const sourceType = item.isReply ? 'reply' : 'comment';
      const publishedAt = item.publishedAtEpochSeconds
        ? new Date(item.publishedAtEpochSeconds * 1000).toISOString()
        : parsedCommentTime(item.publishedAtText, collectedAt);
      opinions.push({
        id: item.sourceRecordId
          ? stableId(candidate.id, sourceType, item.sourceRecordId)
          : stableId(candidate.id, sourceType, item.authorUid ?? item.authorName ?? 'anonymous', item.text),
        runId,
        contentId: candidate.id,
        contentType: candidate.type,
        sourceType,
        voiceType: 'viewer',
        text: item.text,
        publishedAt,
        publishedAtText: item.publishedAtText,
        collectedAt,
        authorUid: item.authorUid,
        authorName: item.authorName,
        authorProfileUrl: item.authorProfileUrl,
        authorHash,
        sourceRecordId: item.sourceRecordId,
        parentSourceRecordId: item.parentSourceRecordId,
        likes: item.likes,
        replies: item.replies,
        sourcePageUrl: candidate.url,
        sourceUrl: commentSourceUrl(candidate.url, item.sourceRecordId, item.parentSourceRecordId, item.sourceUrl)
      });
    });
    return {content, opinions};
  }

  async collect(context: CollectionContext): Promise<CollectionResult> {
    const openedPages: Page[] = [];
    let releaseChrome: (() => void) | undefined;
    try {
      const lease = await this.chromeConnection.acquire();
      releaseChrome = lease.release;
      const createWorkerPage = async () => {
        const page = await lease.context.newPage();
        openedPages.push(page);
        page.setDefaultTimeout(6_000);
        return page;
      };
      const discoveryPage = await createWorkerPage();

      if (context.checkpoint.pendingCandidates.length === 0 && context.checkpoint.seenContentIds.length === 0) {
        await context.callbacks.onState('discovering', '正在从热门搜索结果中发现视频和动态…');
        const candidates = await this.discover(discoveryPage, context);
        context.checkpoint.pendingCandidates = candidates;
        await context.callbacks.onCandidates(candidates);
        await context.callbacks.onCheckpoint(context.checkpoint);
      }

      const configuredWindowCount = Math.max(1, Math.min(4, context.manifest.request.browserWindowCount ?? 1));
      const windowCount = Math.min(configuredWindowCount, Math.max(1, context.checkpoint.pendingCandidates.length));
      const workerPages = [discoveryPage];
      if (windowCount > 1) {
        workerPages.push(...await Promise.all(Array.from({length: windowCount - 1}, () => createWorkerPage())));
      }
      await context.callbacks.onState(
        'collecting',
        windowCount === 1 ? '正在采集热门来源中的公开意见…' : `正在使用 ${windowCount} 个并行窗口采集公开意见…`
      );

      const claimedCandidateIds = new Set<string>();
      let commitQueue = Promise.resolve();
      const commit = async (operation: () => Promise<void>) => {
        const queued = commitQueue.then(operation);
        commitQueue = queued.catch(() => undefined);
        return queued;
      };
      const claimCandidate = () => {
        if (context.callbacks.getDirective() !== 'continue') return undefined;
        const candidate = context.checkpoint.pendingCandidates.find((item) => !claimedCandidateIds.has(item.id));
        if (candidate) claimedCandidateIds.add(candidate.id);
        return candidate;
      };
      const completeCandidate = async (
        candidate: CandidateContent,
        collected?: Awaited<ReturnType<BilibiliBrowserCollector['collectCandidate']>>,
        collectionError?: unknown
      ) => commit(async () => {
        const cutoff = Date.now() - context.manifest.request.contentWindowDays * 86400000;
        if (collectionError) {
          await context.callbacks.onWarning('某个内容页面采集失败，已保存进度并继续。', {
            contentId: candidate.id,
            url: candidate.url,
            error: collectionError instanceof Error ? collectionError.message : String(collectionError)
          });
        } else if (collected) {
          const publishedTime = collected.content.publishedAt
            ? new Date(collected.content.publishedAt).getTime()
            : Number.NaN;
          if (Number.isNaN(publishedTime) || publishedTime >= cutoff) {
            await context.callbacks.onContent(collected.content);
            if (collected.opinions.length === 1) {
              await context.callbacks.onWarning('该页面没有加载出可见评论，已保留内容元数据并继续。', {
                contentId: candidate.id,
                url: candidate.url
              });
            }
            for (const opinion of collected.opinions) {
              if (context.checkpoint.seenOpinionIds.includes(opinion.id)) continue;
              await context.callbacks.onOpinion(opinion);
              context.checkpoint.seenOpinionIds.push(opinion.id);
            }
          }
        }
        if (!context.checkpoint.seenContentIds.includes(candidate.id)) {
          context.checkpoint.seenContentIds.push(candidate.id);
        }
        const pendingIndex = context.checkpoint.pendingCandidates.findIndex((item) => item.id === candidate.id);
        if (pendingIndex >= 0) context.checkpoint.pendingCandidates.splice(pendingIndex, 1);
        claimedCandidateIds.delete(candidate.id);
        await context.callbacks.onCheckpoint(context.checkpoint);
      });
      const collectWorker = async (page: Page) => {
        while (true) {
          const candidate = claimCandidate();
          if (!candidate) return;
          const cutoff = Date.now() - context.manifest.request.contentWindowDays * 86400000;
          if (candidate.publishedAt && new Date(candidate.publishedAt).getTime() < cutoff) {
            await completeCandidate(candidate);
            continue;
          }
          let collected: Awaited<ReturnType<BilibiliBrowserCollector['collectCandidate']>>;
          try {
            collected = await this.collectCandidate(page, candidate, context.manifest.id);
          } catch (error) {
            await completeCandidate(candidate, undefined, error);
            continue;
          }
          await completeCandidate(candidate, collected);
        }
      };

      await Promise.all(workerPages.map((page) => collectWorker(page)));
      await commitQueue;
      const directedOutcome = outcomeForDirective(context.callbacks.getDirective());
      return {outcome: directedOutcome ?? 'source_exhausted', checkpoint: context.checkpoint};
    } finally {
      await Promise.all(openedPages.map((page) => page.close().catch(() => undefined)));
      releaseChrome?.();
    }
  }
}
