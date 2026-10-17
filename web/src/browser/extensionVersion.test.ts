import {describe, expect, it} from 'vitest';
import {isExtensionOutdated, latestExtensionVersion} from './extensionVersion';

describe('extension version', () => {
  it('reads the latest version from the shipped extension manifest', () => {
    expect(latestExtensionVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(isExtensionOutdated(latestExtensionVersion)).toBe(false);
  });

  it('compares dotted versions numerically', () => {
    expect(isExtensionOutdated('0.1.8', '0.1.9')).toBe(true);
    expect(isExtensionOutdated('0.1.9', '0.1.10')).toBe(true);
    expect(isExtensionOutdated('0.1.10', '0.1.9')).toBe(false);
    expect(isExtensionOutdated('0.2', '0.1.9')).toBe(false);
    expect(isExtensionOutdated('0.1', '0.1.0')).toBe(false);
  });

  it('treats a missing or malformed version as outdated', () => {
    expect(isExtensionOutdated(undefined, '0.1.9')).toBe(true);
    expect(isExtensionOutdated('', '0.1.9')).toBe(true);
    expect(isExtensionOutdated('v0.1.9', '0.1.9')).toBe(true);
  });
});
