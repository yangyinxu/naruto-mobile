export const RESEARCH_APP_ID = 'naruto-mobile-research';
export const RESEARCH_API_VERSION = 8;

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined
);

const readJson = async (response: Response) => {
  if (!response.ok) return undefined;
  return asObject(await response.json());
};

/** Identifies another running copy without mistaking an unrelated local service for this tool. */
export const isResearchToolRunning = async (
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1_500
) => {
  const url = baseUrl.replace(/\/$/, '');
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const health = await readJson(await fetchImpl(`${url}/api/health`, {
      headers: {accept: 'application/json'},
      signal
    }));
    if (health?.ok !== true) return false;
    if (health.app === RESEARCH_APP_ID) return true;
    if (health.app !== undefined) return false;

    // Compatibility check for MVP builds created before the app identifier was added.
    const settings = await readJson(await fetchImpl(`${url}/api/settings`, {
      headers: {accept: 'application/json'},
      signal
    }));
    const defaults = asObject(settings?.defaults);
    const keywords = defaults?.keywords;
    return typeof settings?.dataRoot === 'string'
      && Array.isArray(keywords)
      && keywords.includes('火影忍者手游');
  } catch {
    return false;
  }
};
