const appId = 'naruto-mobile-research';
const parsedPort = Number(process.env.PORT || 3765);

if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) process.exit(1);

const baseUrl = `http://127.0.0.1:${parsedPort}`;
const signal = AbortSignal.timeout(1_500);

const readObject = async (path) => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {accept: 'application/json'},
    signal
  });
  if (!response.ok) return undefined;
  const value = await response.json();
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
};

try {
  const health = await readObject('/api/health');
  let isResearchTool = health?.ok === true && health.app === appId;

  if (health?.ok === true && health.app === undefined) {
    const settings = await readObject('/api/settings');
    isResearchTool = typeof settings?.dataRoot === 'string'
      && Array.isArray(settings?.defaults?.keywords)
      && settings.defaults.keywords.includes('火影忍者手游');
  }

  if (!isResearchTool) process.exit(1);
  process.stdout.write(baseUrl);
} catch {
  process.exit(1);
}
