export type RunState =
  | 'created'
  | 'discovering'
  | 'collecting'
  | 'pause_requested'
  | 'paused'
  | 'processing'
  | 'completed'
  | 'completed_early'
  | 'failed_recoverable';

export interface ResearchRequest {
  name: string;
  durationMinutes: number;
  contentWindowDays: number;
  keywords: string[];
  includeVideos: boolean;
  includeDynamics: boolean;
  mode: 'live' | 'demo';
  browserVisible: boolean;
  browserWindowCount: number;
  maxSources: number;
}

export interface RunManifest {
  id: string;
  state: RunState;
  request: ResearchRequest;
  createdAt: string;
  updatedAt: string;
  activeElapsedMs: number;
  statusMessage: string;
  counts: {
    candidates: number;
    contents: number;
    opinions: number;
    validOpinions: number;
    sources: number;
    warnings: number;
  };
  stopReason?: string;
  error?: string;
  reportReady: boolean;
}

export interface RunEvent {
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  type: string;
  message: string;
}

export interface ContentRecord {
  recordSchemaVersion?: 2;
  runId?: string;
  id: string;
  type: 'video' | 'dynamic';
  url: string;
  discoveryUrl?: string;
  resolvedUrl?: string;
  title: string;
  description: string;
  discoveryKeyword: string;
  discoveryRank: number;
  popularityText?: string;
  publishedAt?: string;
  collectedAt: string;
  metrics: {
    views?: number;
    likes?: number;
    comments?: number;
    danmaku?: number;
  };
}

export interface OpinionRecord {
  recordSchemaVersion?: 2;
  id: string;
  runId?: string;
  contentId: string;
  contentType: 'video' | 'dynamic';
  sourceType: 'comment' | 'reply' | 'danmaku' | 'creator_view';
  voiceType: 'viewer' | 'creator';
  text: string;
  normalizedText?: string;
  publishedAt?: string;
  publishedAtText?: string;
  collectedAt: string;
  authorUid?: string;
  authorName?: string;
  authorProfileUrl?: string;
  authorHash?: string;
  sourceRecordId?: string;
  parentSourceRecordId?: string;
  likes: number;
  replies: number;
  sourcePageUrl?: string;
  sourceUrl: string;
}

interface RecordPageBase {
  total: number;
  offset: number;
  limit: number;
}

export type RunRecordsResponse =
  | (RecordPageBase & {
      kind: 'opinions';
      records: Array<{record: OpinionRecord; contentTitle?: string}>;
    })
  | (RecordPageBase & {
      kind: 'contents';
      records: ContentRecord[];
    });

export interface AppSettings {
  apiVersion?: number;
  dataRoot: string;
  dataRootLocked?: boolean;
  defaults: Omit<ResearchRequest, 'name'>;
}

export interface ChromeConnectionStatus {
  state: 'not_ready' | 'ready' | 'connecting' | 'connected' | 'error';
  remoteDebuggingEnabled: boolean;
  connected: boolean;
  loginState: 'unknown' | 'logged_in' | 'logged_out';
  accountName?: string;
  accountUidSuffix?: string;
  activeInvestigations: number;
  message: string;
}
