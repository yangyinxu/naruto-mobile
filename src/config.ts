import * as dotenv from 'dotenv';
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {readSavedDataRoot} from './services/dataRootSettings';

dotenv.config();

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const booleanValue = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
};

export interface AppConfig {
  host: string;
  port: number;
  dataRoot: string;
  browserChannel: string;
  browserHeadless: boolean;
  openBrowser: boolean;
  uidSalt: string;
}

export const localUidSalt = (dataRoot: string) => {
  const configured = process.env.RESEARCH_UID_SALT?.trim();
  if (configured) return configured;

  mkdirSync(dataRoot, {recursive: true});
  const saltPath = join(dataRoot, '.uid-salt');
  try {
    const existing = readFileSync(saltPath, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(32).toString('hex');
  try {
    writeFileSync(saltPath, `${generated}\n`, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readFileSync(saltPath, 'utf8').trim();
  }
};

/** Loads local-only settings without silently choosing a remote listener. */
export const loadAppConfig = (): AppConfig => {
  const dataRoot = resolve(process.env.RESEARCH_DATA_DIR?.trim() || readSavedDataRoot() || 'data');
  return {
    host: '127.0.0.1',
    port: positiveInteger(process.env.PORT, 3765),
    dataRoot,
    browserChannel: process.env.BROWSER_CHANNEL?.trim() || 'chrome',
    browserHeadless: booleanValue(process.env.BROWSER_HEADLESS, false),
    openBrowser: !booleanValue(process.env.NO_OPEN, false),
    uidSalt: localUidSalt(dataRoot)
  };
};
