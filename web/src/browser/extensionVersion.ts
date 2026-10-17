import extensionManifest from '../../../extension/manifest.json';

/** The extension version shipped beside this portal's download, read from its manifest. */
export const latestExtensionVersion: string = extensionManifest.version;

/** Compares dotted numeric versions; a missing or malformed version counts as outdated. */
export const isExtensionOutdated = (version: string | undefined, latest = latestExtensionVersion) => {
  if (!version || !/^\d+(\.\d+)*$/.test(version)) return true;
  const current = version.split('.').map(Number), expected = latest.split('.').map(Number);
  for (let index = 0; index < Math.max(current.length, expected.length); index += 1) {
    const difference = (current[index] ?? 0) - (expected[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
};
