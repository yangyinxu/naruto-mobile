import * as dotenv from 'dotenv';
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {readSavedDataRoot} from './services/dataRootSettings';
import {DEFAULT_NARUTO_PROXY_BASE_URL} from './services/archtreeAuth';
import {ReasoningEffort} from './domain/types';

export const resolveEnvFileCandidates = (
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env
) => {
  const portableExecutableDir = environment.PORTABLE_EXECUTABLE_DIR?.trim()
    || (environment.PORTABLE_EXECUTABLE_FILE?.trim()
      ? dirname(environment.PORTABLE_EXECUTABLE_FILE.trim())
      : undefined);
  return [...new Set([
    environment.OPENAI_ENV_FILE?.trim()
      ? resolve(cwd, environment.OPENAI_ENV_FILE.trim()) : undefined,
    resolve(cwd, '.env'),
    portableExecutableDir ? join(portableExecutableDir, '.env') : undefined,
    portableExecutableDir ? resolve(portableExecutableDir, '..', '.env') : undefined
  ].filter((value): value is string => Boolean(value)))];
};

for (const path of resolveEnvFileCandidates()) {
  dotenv.config({path, override: false, quiet: true});
}

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const booleanValue = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
};

const reasoningEffort = (value: string | undefined): ReasoningEffort => {
  const normalized = value?.trim().toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized ?? '')
    ? normalized as ReasoningEffort : 'medium';
};

export interface AppConfig {
  host: string;
  port: number;
  dataRoot: string;
  browserChannel: string;
  browserHeadless: boolean;
  openBrowser: boolean;
  uidSalt: string;
  analysisTransport?: 'proxy' | 'direct';
  proxyBaseUrl?: string;
  openAiApiKey?: string;
  aiModel: string;
  aiReasoningEffort: ReasoningEffort;
  aiBatchSize: number;
  aiConcurrency: number;
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
  const defaultDataRoot = process.env.RESEARCH_DEFAULT_DATA_DIR?.trim() || 'data';
  const dataRoot = resolve(process.env.RESEARCH_DATA_DIR?.trim() || readSavedDataRoot() || defaultDataRoot);
  const configuredTransport = process.env.NARUTO_MOBILE_ANALYSIS_TRANSPORT?.trim().toLowerCase();
  return {
    host: '127.0.0.1',
    port: positiveInteger(process.env.PORT, 3765),
    dataRoot,
    browserChannel: process.env.BROWSER_CHANNEL?.trim() || 'chrome',
    browserHeadless: booleanValue(process.env.BROWSER_HEADLESS, false),
    openBrowser: !booleanValue(process.env.NO_OPEN, false),
    uidSalt: localUidSalt(dataRoot),
    analysisTransport: configuredTransport === 'direct' || configuredTransport === 'proxy'
      ? configuredTransport
      : process.env.OPENAI_API_KEY?.trim() ? 'direct' : 'proxy',
    proxyBaseUrl: process.env.NARUTO_MOBILE_PROXY_BASE_URL?.trim()
      || DEFAULT_NARUTO_PROXY_BASE_URL,
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    aiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
    aiReasoningEffort: reasoningEffort(process.env.OPENAI_REASONING_EFFORT),
    aiBatchSize: positiveInteger(process.env.OPENAI_BATCH_SIZE, 10),
    aiConcurrency: positiveInteger(process.env.OPENAI_CONCURRENCY, 3)
  };
};
