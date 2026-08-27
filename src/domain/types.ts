export const runStates = [
  'created',
  'discovering',
  'collecting',
  'pause_requested',
  'paused',
  'processing',
  'completed',
  'completed_early',
  'failed_recoverable'
] as const;

export type RunState = typeof runStates[number];
export type ResearchMode = 'live' | 'demo';
export type ContentType = 'video' | 'dynamic';
export type StopReason = 'budget_exhausted' | 'source_exhausted' | 'user_finalized';

export interface ResearchRequest {
  name: string;
  durationMinutes: number;
  contentWindowDays: number;
  keywords: string[];
  includeVideos: boolean;
  includeDynamics: boolean;
  mode: ResearchMode;
  browserVisible: boolean;
  browserWindowCount: number;
  maxSources: number;
}

export interface RunCounts {
  candidates: number;
  contents: number;
  opinions: number;
  validOpinions: number;
  sources: number;
  warnings: number;
}

export interface RunManifest {
  schemaVersion: 1;
  id: string;
  state: RunState;
  request: ResearchRequest;
  createdAt: string;
  updatedAt: string;
  activeElapsedMs: number;
  statusMessage: string;
  counts: RunCounts;
  stopReason?: StopReason;
  error?: string;
  reportReady: boolean;
}

export interface CandidateContent {
  id: string;
  type: ContentType;
  url: string;
  discoveryUrl?: string;
  title: string;
  discoveryKeyword: string;
  discoveryRank: number;
  popularityText?: string;
  publishedAt?: string;
}

export interface ContentRecord extends CandidateContent {
  recordSchemaVersion?: 2;
  /** Run directory identifier. Optional only when reading records created before schema v2. */
  runId?: string;
  /** Final URL after browser redirects, retained beside the canonical discovery URL. */
  resolvedUrl?: string;
  description: string;
  collectedAt: string;
  metrics: {
    views?: number;
    likes?: number;
    comments?: number;
    danmaku?: number;
  };
}

export type OpinionSourceType = 'comment' | 'reply' | 'danmaku' | 'creator_view';

export interface OpinionRecord {
  recordSchemaVersion?: 2;
  id: string;
  /** Run directory identifier. Optional only when reading records created before schema v2. */
  runId?: string;
  contentId: string;
  contentType: ContentType;
  sourceType: OpinionSourceType;
  voiceType: 'viewer' | 'creator';
  text: string;
  normalizedText?: string;
  publishedAt?: string;
  /** Exact public timestamp label when it cannot be converted reliably to ISO 8601. */
  publishedAtText?: string;
  collectedAt: string;
  /** Public author metadata is intentionally retained as plain text for source tracing. */
  authorUid?: string;
  authorName?: string;
  authorProfileUrl?: string;
  /** Backward-compatible derived key; it never replaces the plain author fields above. */
  authorHash?: string;
  /** Platform comment/reply identifier and its root/parent identifier when exposed. */
  sourceRecordId?: string;
  parentSourceRecordId?: string;
  likes: number;
  replies: number;
  /** Content page from which the record was collected. */
  sourcePageUrl?: string;
  /** Direct comment/reply URL when available, otherwise the content page URL. */
  sourceUrl: string;
}

export interface ClassificationRecord {
  opinionId: string;
  relevanceScore: number;
  relevanceLevel: 'high' | 'medium' | 'low';
  isValid: boolean;
  invalidReason?: string;
  topics: string[];
  topicSentiments: Record<string, 'positive' | 'negative' | 'mixed' | 'neutral'>;
  emotion: 'appreciation' | 'frustration' | 'mixed' | 'neutral';
  stance: 'praise' | 'complaint' | 'suggestion' | 'discussion';
  severity: number;
  behaviorIntents: string[];
  playerSegment: string;
  actionability: 'high' | 'medium' | 'low';
  confidence: number;
  classifierVersion: string;
  matchedTerms: Record<string, string[]>;
}

export interface RunCheckpoint {
  schemaVersion: 1;
  pendingCandidates: CandidateContent[];
  seenContentIds: string[];
  seenOpinionIds: string[];
  activeElapsedMs: number;
  updatedAt: string;
}

export interface RunEvent {
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  type: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CollectionCallbacks {
  getDirective: () => 'continue' | 'pause' | 'finalize' | 'budget_exhausted';
  remainingMs: () => number;
  onState: (state: 'discovering' | 'collecting', message: string) => Promise<void>;
  onCandidates: (candidates: CandidateContent[]) => Promise<void>;
  onContent: (content: ContentRecord) => Promise<void>;
  onOpinion: (opinion: OpinionRecord) => Promise<void>;
  onCheckpoint: (checkpoint: RunCheckpoint) => Promise<void>;
  onWarning: (message: string, details?: Record<string, unknown>) => Promise<void>;
}

export interface CollectionContext {
  manifest: RunManifest;
  checkpoint: RunCheckpoint;
  callbacks: CollectionCallbacks;
}

export interface CollectionResult {
  outcome: 'paused' | 'finalized' | 'budget_exhausted' | 'source_exhausted';
  checkpoint: RunCheckpoint;
}

export interface Collector {
  collect(context: CollectionContext): Promise<CollectionResult>;
}
