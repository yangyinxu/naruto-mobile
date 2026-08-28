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
export type AnalysisMode = 'ai' | 'rule_demo';
export type InsightValue = 'strong' | 'weak' | 'none';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type RunProgressPhase = 'preparing' | 'discovering' | 'collecting' | 'analyzing' | 'reporting' | 'completed';

export interface RunProgress {
  phase: RunProgressPhase;
  completed?: number;
  total?: number;
}

export interface AiTokenUsage {
  requestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  pricing?: {
    currency: 'USD';
    inputPerMillion: number;
    cachedInputPerMillion: number;
    outputPerMillion: number;
    checkedAt: string;
    sourceUrl: string;
  };
}

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
  progress?: RunProgress;
  counts: RunCounts;
  stopReason?: StopReason;
  error?: string;
  reportReady: boolean;
  analysis?: {
    mode: AnalysisMode;
    classifierVersion: string;
    model?: string;
    completedAt: string;
    strongOpinions: number;
    weakOpinions: number;
    noiseOpinions: number;
    localHardNoise?: number;
    creatorViewsExcluded?: number;
    fastTriageSkipped?: number;
    detailedAiOpinions?: number;
    usage?: AiTokenUsage;
  };
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
  /** Added by schema v3 processors. Older derived records omit these fields. */
  analysisMode?: AnalysisMode;
  gameRelevant?: boolean;
  insightValue?: InsightValue;
  informationType?: 'product_feedback' | 'gameplay_advice' | 'factual_info' | 'community_chatter' | 'lore_discussion' | 'content_request';
  claimObject?: string;
  claim?: string;
  specificitySignals?: Array<'cause' | 'mechanism' | 'impact' | 'comparison' | 'suggestion' | 'behavior_with_reason'>;
  reportEligible?: boolean;
  reasonCodes?: string[];
  evidence?: Array<{topic: string; quote: string}>;
  needsReview?: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface AiClassificationCacheRecord {
  opinionId: string;
  inputHash: string;
  classification: ClassificationRecord;
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
