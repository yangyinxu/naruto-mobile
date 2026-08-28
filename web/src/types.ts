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

export type RunProgressPhase = 'preparing' | 'discovering' | 'collecting' | 'analyzing' | 'reporting' | 'completed';

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
  progress?: {
    phase: RunProgressPhase;
    completed?: number;
    total?: number;
  };
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
  analysis?: {
    mode: 'ai' | 'rule_demo';
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

export type ReportSentiment = 'positive' | 'mixed' | 'negative' | 'neutral';

export interface ReportEvidence {
  id: string;
  sentiment: ReportSentiment;
  text: string;
  evidence: string;
  claim: string;
  severity: number;
  confidence: number;
  likes: number;
  replies: number;
  authorName: string;
  sourceTitle: string;
  sourceUrl: string;
  publishedAt?: string;
}

export interface ReportTopic {
  topic: string;
  summary: string;
  count: number;
  positive: number;
  mixed: number;
  negative: number;
  neutral: number;
  sources: number;
  authors: number;
  averageSeverity: number;
  riskScore: number;
  netSentiment: number;
  reviewStatus: string;
  evidence: Record<ReportSentiment, ReportEvidence[]>;
}

export interface ReportData {
  title: string;
  runId: string;
  generatedAt: string;
  conclusion: string;
  sample: {
    sourceCount: number;
    rawOpinions: number;
    validOpinions: number;
    topicCount: number;
    warnings: number;
    confidenceLabel: string;
    confidenceExplanation: string;
  };
  topics: ReportTopic[];
  quality: {
    analysisMode: 'ai' | 'rule_demo';
    analysisLabel: string;
    model?: string;
    strongOpinions: number;
    weakOpinions: number;
    noiseOpinions: number;
    duplicateOpinions: number;
    localHardNoise: number;
    creatorViewsExcluded: number;
    cachedAiOpinions: number;
    detailedAiOpinions: number;
    usage?: AiTokenUsage;
    usageExplanation: string;
  };
  limitations: string[];
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
  analysis?: {
    aiConfigured: boolean;
    model: string;
    reasoningEffort: string;
    liveMode: 'ai';
    demoMode: 'rule_demo';
  };
  defaults: Omit<ResearchRequest, 'name'>;
}

export interface ChromeConnectionStatus {
  state: 'not_ready' | 'ready' | 'connecting' | 'disconnecting' | 'connected' | 'error';
  remoteDebuggingEnabled: boolean;
  connected: boolean;
  loginState: 'unknown' | 'logged_in' | 'logged_out';
  accountName?: string;
  accountUidSuffix?: string;
  activeInvestigations: number;
  message: string;
}
