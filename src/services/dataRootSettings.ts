import {randomUUID} from 'node:crypto';
import {mkdir, rename, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';

interface LocalSettings {
  dataRoot?: string;
}

export const dataRootSettingsPath = () => {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA?.trim() || process.env.APPDATA?.trim() || homedir()
    : process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'naruto-mobile-research', 'settings.json');
};

export const readSavedDataRoot = (settingsPath = dataRootSettingsPath()) => {
  try {
    const value = JSON.parse(readFileSync(settingsPath, 'utf8')) as LocalSettings;
    const saved = value.dataRoot?.trim();
    return saved && isAbsolute(saved) ? resolve(saved) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
};

export const saveDataRoot = async (dataRoot: string, settingsPath = dataRootSettingsPath()) => {
  const normalized = resolve(dataRoot);
  const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(settingsPath), {recursive: true});
  await writeFile(temporaryPath, `${JSON.stringify({dataRoot: normalized}, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, settingsPath);
  return normalized;
};
