import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ClassificationRecord,
  ContentRecord,
  OpinionRecord,
  ResearchRequest,
  RunCheckpoint,
  RunEvent,
  RunManifest
} from '../domain/types';

const runIdPattern = /^\d{8}T\d{6}-[a-f0-9]{8}$/;

const timestampId = () => {
  const time = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  return `${time}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
};

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

const atomicJsonWrite = async (path: string, value: unknown) => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(temporaryPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  await rm(temporaryPath, {force: true}).catch(() => undefined);
  throw lastError;
};

const readJsonLines = async <T>(path: string): Promise<T[]> => {
  try {
    return (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

/** Stores one append-only, resumable research run entirely in a local directory. */
export class FileRunStore {
  readonly root: string;
  readonly runsRoot: string;
  private readonly manifestQueues = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = resolve(root);
    this.runsRoot = join(this.root, 'runs');
  }

  async initialize() {
    await Promise.all([
      mkdir(this.runsRoot, {recursive: true}),
      mkdir(join(this.root, 'cache'), {recursive: true})
    ]);
  }

  runDirectory(runId: string) {
    if (!runIdPattern.test(runId)) throw new Error('调查 ID 格式不正确。');
    return join(this.runsRoot, runId);
  }

  private path(runId: string, ...parts: string[]) {
    return join(this.runDirectory(runId), ...parts);
  }

  async createRun(request: ResearchRequest): Promise<RunManifest> {
    const id = timestampId();
    const directory = this.runDirectory(id);
    await Promise.all([
      mkdir(join(directory, 'raw'), {recursive: true}),
      mkdir(join(directory, 'processed'), {recursive: true}),
      mkdir(join(directory, 'reports'), {recursive: true})
    ]);
    const now = new Date().toISOString();
    const manifest: RunManifest = {
      schemaVersion: 1,
      id,
      state: 'created',
      request,
      createdAt: now,
      updatedAt: now,
      activeElapsedMs: 0,
      statusMessage: '调查已创建，正在准备采集。',
      counts: {
        candidates: 0,
        contents: 0,
        opinions: 0,
        validOpinions: 0,
        sources: 0,
        warnings: 0
      },
      reportReady: false
    };
    const checkpoint: RunCheckpoint = {
      schemaVersion: 1,
      pendingCandidates: [],
      seenContentIds: [],
      seenOpinionIds: [],
      activeElapsedMs: 0,
      updatedAt: now
    };
    await Promise.all([
      atomicJsonWrite(this.path(id, 'manifest.json'), manifest),
      atomicJsonWrite(this.path(id, 'checkpoint.json'), checkpoint),
      this.appendEvent(id, {timestamp: now, level: 'info', type: 'run_created', message: '调查已创建。'})
    ]);
    return manifest;
  }

  async getManifest(runId: string) {
    return readJson<RunManifest>(this.path(runId, 'manifest.json'));
  }

  async listManifests(): Promise<RunManifest[]> {
    await this.initialize();
    const entries = await readdir(this.runsRoot, {withFileTypes: true});
    const manifests = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && runIdPattern.test(entry.name))
      .map(async (entry) => {
        try {
          return await this.getManifest(entry.name);
        } catch {
          return null;
        }
      }));
    return manifests
      .filter((item): item is RunManifest => Boolean(item))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async updateManifest(
    runId: string,
    update: (current: RunManifest) => RunManifest | Promise<RunManifest>
  ): Promise<RunManifest> {
    const previous = this.manifestQueues.get(runId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const current = await this.getManifest(runId);
      const next = await update(current);
      next.updatedAt = new Date().toISOString();
      await atomicJsonWrite(this.path(runId, 'manifest.json'), next);
      return next;
    });
    this.manifestQueues.set(runId, operation);
    try {
      return await operation;
    } finally {
      if (this.manifestQueues.get(runId) === operation) this.manifestQueues.delete(runId);
    }
  }

  async readCheckpoint(runId: string) {
    return readJson<RunCheckpoint>(this.path(runId, 'checkpoint.json'));
  }

  async writeCheckpoint(runId: string, checkpoint: RunCheckpoint) {
    checkpoint.updatedAt = new Date().toISOString();
    await atomicJsonWrite(this.path(runId, 'checkpoint.json'), checkpoint);
  }

  async appendEvent(runId: string, event: RunEvent) {
    await appendFile(this.path(runId, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readEvents(runId: string, limit = 100) {
    const events = await readJsonLines<RunEvent>(this.path(runId, 'events.jsonl'));
    return events.slice(-Math.max(1, Math.min(limit, 500)));
  }

  async appendContent(runId: string, content: ContentRecord) {
    const traceableRecord: ContentRecord = {...content, recordSchemaVersion: 2, runId};
    await appendFile(this.path(runId, 'raw', 'contents.jsonl'), `${JSON.stringify(traceableRecord)}\n`, 'utf8');
  }

  async appendOpinion(runId: string, opinion: OpinionRecord) {
    const traceableRecord: OpinionRecord = {
      ...opinion,
      recordSchemaVersion: 2,
      runId,
      sourcePageUrl: opinion.sourcePageUrl || opinion.sourceUrl
    };
    await appendFile(this.path(runId, 'raw', 'opinions.jsonl'), `${JSON.stringify(traceableRecord)}\n`, 'utf8');
  }

  async readContents(runId: string) {
    return readJsonLines<ContentRecord>(this.path(runId, 'raw', 'contents.jsonl'));
  }

  async readOpinions(runId: string) {
    return readJsonLines<OpinionRecord>(this.path(runId, 'raw', 'opinions.jsonl'));
  }

  async writeProcessedOpinions(runId: string, opinions: OpinionRecord[]) {
    const value = opinions.map((item) => JSON.stringify(item)).join('\n');
    await writeFile(this.path(runId, 'processed', 'opinions.jsonl'), value ? `${value}\n` : '', 'utf8');
  }

  async writeClassifications(runId: string, items: ClassificationRecord[]) {
    const value = items.map((item) => JSON.stringify(item)).join('\n');
    await writeFile(this.path(runId, 'processed', 'classifications.jsonl'), value ? `${value}\n` : '', 'utf8');
  }

  async writeQualityReport(runId: string, report: unknown) {
    await atomicJsonWrite(this.path(runId, 'processed', 'quality-report.json'), report);
  }

  async writeReport(runId: string, markdown: string) {
    await writeFile(this.path(runId, 'reports', 'report.md'), markdown, 'utf8');
  }

  async readReport(runId: string) {
    return readFile(this.path(runId, 'reports', 'report.md'), 'utf8');
  }

  async acquireRunLock(runId: string): Promise<() => Promise<void>> {
    const lockPath = this.path(runId, '.active.lock');
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({pid: process.pid, createdAt: new Date().toISOString()}));
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let active = true;
      try {
        const owner = await readJson<{pid: number}>(lockPath);
        process.kill(owner.pid, 0);
      } catch (ownerError) {
        active = (ownerError as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (active) throw new Error('该调查正在另一个进程中运行。');
      await rm(lockPath, {force: true});
      return this.acquireRunLock(runId);
    }
    return async () => rm(lockPath, {force: true});
  }

  async isReportReady(runId: string) {
    try {
      return (await stat(this.path(runId, 'reports', 'report.md'))).isFile();
    } catch {
      return false;
    }
  }
}
