import {createHash} from 'node:crypto';

export const stableId = (...parts: string[]) => createHash('sha256')
  .update(parts.join('\0'), 'utf8')
  .digest('base64url')
  .slice(0, 24);

export const normalizedUrl = (value: string) => {
  try {
    const url = new URL(value, 'https://www.bilibili.com');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
};

export const contentIdFromUrl = (url: string, type: 'video' | 'dynamic' | 'article') => {
  const match = type === 'video'
    ? url.match(/\/video\/(BV[\w]+)/i)
    : type === 'article' ? url.match(/\/read\/(cv\d+)/i)
      : url.match(/\/(?:opus\/)?(\d{6,})/);
  return match?.[1] ?? `${type}_${stableId(url)}`;
};

export const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});
