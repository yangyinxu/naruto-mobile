import { ResearchRequest } from './types';

export class RequestValidationError extends Error {
  readonly statusCode = 400;
}

const normalizedInteger = (value: unknown, label: string, minimum: number, maximum: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RequestValidationError(`${label}必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  return parsed;
};

/** Validates the beginner-facing form and returns one canonical research request. */
export const normalizeResearchRequest = (value: unknown): ResearchRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError('调查设置格式不正确。');
  }
  const source = value as Record<string, unknown>;
  const keywords = Array.isArray(source.keywords)
    ? [...new Set(source.keywords.map((item) => String(item).trim()).filter(Boolean))]
    : [];
  if (keywords.length === 0 || keywords.length > 12) {
    throw new RequestValidationError('请提供 1 到 12 个调查关键词。');
  }
  if (keywords.some((item) => item.length > 40)) {
    throw new RequestValidationError('单个关键词不能超过 40 个字符。');
  }

  const includeVideos = source.includeVideos !== false;
  const includeDynamics = source.includeDynamics !== false;
  if (!includeVideos && !includeDynamics) {
    throw new RequestValidationError('视频和动态至少选择一种。');
  }
  const mode = source.mode === 'demo' ? 'demo' : 'live';
  return {
    name: String(source.name ?? '').trim().slice(0, 80) || '火影手游玩家反馈调查',
    durationMinutes: normalizedInteger(source.durationMinutes ?? 5, '采集时间', 1, 720),
    contentWindowDays: normalizedInteger(source.contentWindowDays ?? 30, '内容范围', 1, 365),
    keywords,
    includeVideos,
    includeDynamics,
    mode,
    browserVisible: source.browserVisible !== false,
    browserWindowCount: normalizedInteger(source.browserWindowCount ?? 1, '并行窗口数', 1, 4),
    maxSources: normalizedInteger(source.maxSources ?? 20, '最大来源数', 3, 200)
  };
};
