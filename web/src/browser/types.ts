import type {
  AiClassificationCacheRecord, CandidateContent, ClassificationRecord, ContentRecord,
  OpinionRecord, RunCheckpoint, RunEvent, RunManifest
} from '../../../src/domain/types';

/** One atomic local snapshot; no account credentials are part of the persisted record. */
export interface BrowserRun {
  id: string;
  manifest: RunManifest;
  checkpoint: RunCheckpoint;
  candidates: CandidateContent[];
  contents: ContentRecord[];
  opinions: OpinionRecord[];
  processedOpinions: OpinionRecord[];
  classifications: ClassificationRecord[];
  aiClassifications: ClassificationRecord[];
  cache: AiClassificationCacheRecord[];
  events: RunEvent[];
  quality?: Record<string, unknown>;
  report?: string;
}

/** Extension messages carry public Bilibili records only, never proxy credentials. */
export interface ExtensionEvent {
  channel: 'naruto-extension-v1';
  direction: 'event';
  runId: string;
  type: 'state' | 'candidates' | 'content' | 'opinion' | 'checkpoint' | 'warning' | 'complete';
  payload: unknown;
}

export interface ExtensionBridge {
  request<T>(method: string, payload?: unknown): Promise<T>;
  subscribe(listener: (event: ExtensionEvent) => void): () => void;
}

export type AccountViewer = {userId: string; email: string; role: 'admin' | 'user'};

/** Injectable persistence keeps state-transition tests independent of the UI. */
export interface RunStorage {
  list(): Promise<BrowserRun[]>;
  get(id: string): Promise<BrowserRun>;
  create(run: BrowserRun): Promise<void>;
  delete(id: string): Promise<void>;
  update(id: string, transform: (run: BrowserRun) => BrowserRun): Promise<BrowserRun>;
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;
}
