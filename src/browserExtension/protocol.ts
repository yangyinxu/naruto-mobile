import type {CandidateContent, ResearchRequest, RunCheckpoint} from '../domain/types';
import {normalizeResearchRequest} from '../domain/validation';

export const CHANNEL = 'naruto-extension-v1';
export const METHODS = ['status', 'connect', 'disconnect', 'start', 'pause', 'resume', 'finalize'] as const;
export type ExtensionMethod = typeof METHODS[number];
export interface ExtensionRequest {
  channel: typeof CHANNEL;
  direction: 'request';
  id: string;
  method: ExtensionMethod;
  payload?: unknown;
}
export interface CollectionInput {
  manifest: {id: string; request: ResearchRequest};
  checkpoint: RunCheckpoint;
}

/** Grants the bridge to the hosted portal and explicit local preview/Archtree ports. */
export function isPortalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || !/^\/naruto(?:\/|$)/.test(url.pathname)) return false;
    return url.origin === 'https://kashewt.com'
      || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
        && ['5173', '3765', '8080'].includes(url.port));
  } catch { return false; }
}

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((key) => ['channel', 'direction', 'id', 'method', 'payload'].includes(key))
    && item.channel === CHANNEL && item.direction === 'request'
    && typeof item.id === 'string' && /^[\w-]{1,96}$/.test(item.id)
    && METHODS.includes(item.method as ExtensionMethod);
}

/** Content navigation accepts canonical public content links, never an arbitrary URL. */
export function contentUrl(value: string, type: 'video' | 'dynamic'): string | undefined {
  try {
    const url = new URL(value, 'https://www.bilibili.com');
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    if (type === 'video' && url.hostname === 'www.bilibili.com') {
      const id = url.pathname.match(/^\/video\/(BV[\w]+)\/?$/)?.[1];
      return id ? `https://www.bilibili.com/video/${id}` : undefined;
    }
    if (type === 'dynamic') {
      const id = url.hostname === 'www.bilibili.com' ? url.pathname.match(/^\/opus\/(\d{6,})\/?$/)?.[1]
        : url.hostname === 't.bilibili.com' ? url.pathname.match(/^\/(\d{6,})\/?$/)?.[1] : undefined;
      return id ? `https://${url.hostname}/${url.hostname === 'www.bilibili.com' ? 'opus/' : ''}${id}` : undefined;
    }
  } catch { /* Reject malformed links from untrusted pages. */ }
  return undefined;
}

export function isBilibiliUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['www.bilibili.com', 'search.bilibili.com', 't.bilibili.com', 'api.bilibili.com'].includes(url.hostname);
  } catch { return false; }
}

export function searchUrls(request: ResearchRequest, now = Date.now()) {
  const end = Math.floor(now / 1000);
  return request.keywords.flatMap((keyword) => {
    const query = `keyword=${encodeURIComponent(keyword)}&pubtime_begin_s=${end - request.contentWindowDays * 86400}&pubtime_end_s=${end}`;
    return [
      ...(request.includeVideos ? [{type: 'video' as const, keyword, url: `https://search.bilibili.com/video?${query}&order=click`}] : []),
      ...(request.includeDynamics ? [{type: 'dynamic' as const, keyword, url: `https://search.bilibili.com/dynamic?${query}`}] : [])
    ];
  });
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('调查采集参数格式不正确。');
  return value as Record<string, unknown>;
};
const idList = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 200_000
    || value.some((item) => typeof item !== 'string' || !item.length || item.length > 512 || /[\u0000-\u001f]/.test(item))) {
    throw new Error('调查检查点格式不正确。');
  }
  return [...new Set(value as string[])];
};

/** Validates a resumable job before any browser tab is created. */
export function collectionInput(value: unknown): CollectionInput {
  const source = object(value);
  const manifest = object(source.manifest);
  const checkpoint = object(source.checkpoint);
  if (typeof manifest.id !== 'string' || !/^\d{8}T\d{6}-[a-f0-9]{8}$/.test(manifest.id)) throw new Error('调查 ID 格式不正确。');
  const requestSource = object(manifest.request);
  if (requestSource.mode !== 'live' || ![4, 8].includes(Number(requestSource.browserWindowCount))) throw new Error('真实采集仅支持 4 或 8 个并行标签页。');
  if (!Array.isArray(requestSource.keywords) || requestSource.keywords.some((item) => typeof item !== 'string')) throw new Error('调查关键词格式不正确。');
  const totalMinutes = requestSource.durationMinutes;
  if (typeof totalMinutes !== 'number' || !Number.isSafeInteger(totalMinutes) || totalMinutes < 1
    || totalMinutes > Math.floor(Number.MAX_SAFE_INTEGER / 60_000)) throw new Error('调查累计采集时间不正确。');
  // Each user input is bounded to 720 minutes, but repeated extensions preserve
  // the desktop contract by allowing a larger cumulative budget on resume.
  const request = {...normalizeResearchRequest({...requestSource, durationMinutes: Math.min(totalMinutes, 720)}), durationMinutes: totalMinutes};
  if (checkpoint.schemaVersion !== 1 || !Array.isArray(checkpoint.pendingCandidates) || checkpoint.pendingCandidates.length > 200
    || typeof checkpoint.activeElapsedMs !== 'number' || !Number.isFinite(checkpoint.activeElapsedMs) || checkpoint.activeElapsedMs < 0
    || typeof checkpoint.updatedAt !== 'string' || !Number.isFinite(Date.parse(checkpoint.updatedAt))) throw new Error('调查检查点格式不正确。');
  const pendingCandidates = checkpoint.pendingCandidates.map((value): CandidateContent => {
    const candidate = object(value);
    const type = candidate.type;
    if (type !== 'video' && type !== 'dynamic') throw new Error('候选来源格式不正确。');
    const url = typeof candidate.url === 'string' ? contentUrl(candidate.url, type) : undefined;
    const canonicalId = url?.match(type === 'video' ? /\/video\/(BV[\w]+)/ : /\/(\d{6,})$/)?.[1];
    if (!url || candidate.id !== canonicalId || typeof candidate.title !== 'string' || candidate.title.length > 2000
      || typeof candidate.discoveryKeyword !== 'string' || !request.keywords.includes(candidate.discoveryKeyword)
      || typeof candidate.discoveryRank !== 'number' || !Number.isSafeInteger(candidate.discoveryRank) || candidate.discoveryRank < 1
      || (candidate.publishedAt !== undefined && (typeof candidate.publishedAt !== 'string' || !Number.isFinite(Date.parse(candidate.publishedAt))))) {
      throw new Error('候选来源格式不正确。');
    }
    return {id: canonicalId!, type, url, title: candidate.title, discoveryKeyword: candidate.discoveryKeyword,
      discoveryRank: candidate.discoveryRank, ...(candidate.publishedAt ? {publishedAt: candidate.publishedAt as string} : {})};
  });
  return {manifest: {id: manifest.id, request}, checkpoint: {schemaVersion: 1, pendingCandidates,
    seenContentIds: idList(checkpoint.seenContentIds), seenOpinionIds: idList(checkpoint.seenOpinionIds),
    activeElapsedMs: checkpoint.activeElapsedMs, updatedAt: checkpoint.updatedAt}};
}

/** Matches the desktop SHA-256 identifier contract without Node or browser secrets. */
export async function stableBrowserId(...parts: string[]): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\0'))));
  const base64 = btoa(String.fromCharCode(...hash));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 24);
}
