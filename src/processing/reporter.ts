import {
  AiTokenUsage,
  ClassificationRecord,
  ContentRecord,
  OpinionRecord,
  RunManifest
} from '../domain/types';

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

const percent = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`;
const clean = (text: string) => text.replace(/\|/g, '／').replace(/\s+/g, ' ').trim();
const excerpt = (text: string, length = 76) => {
  const value = clean(text);
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
};
const numeric = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

const isUsage = (value: unknown): value is AiTokenUsage => {
  if (!value || typeof value !== 'object') return false;
  const usage = value as Partial<AiTokenUsage>;
  return ['requestCount', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens']
    .every((key) => Number.isFinite(Number(usage[key as keyof AiTokenUsage])));
};

const sentimentCopy: Record<ReportSentiment, string> = {
  positive: '正向',
  mixed: '混合',
  negative: '负向',
  neutral: '中性'
};

const summaryFor = (
  counts: Record<ReportSentiment, number>,
  pairs: Array<[OpinionRecord, ClassificationRecord]>
) => {
  const count = pairs.length;
  const ranked = (Object.entries(counts) as Array<[ReportSentiment, number]>)
    .sort((left, right) => right[1] - left[1]);
  const [leadingSentiment, leadingCount] = ranked[0] ?? ['neutral', 0];
  const represented = ranked.filter(([, value]) => value > 0).map(([sentiment]) => sentimentCopy[sentiment]);
  const tone = leadingCount * 2 > count
    ? `整体以${sentimentCopy[leadingSentiment]}反馈为主。`
    : `${represented.join('、')}观点并存，暂未形成单一倾向。`;
  const claims = [...new Set(pairs
    .sort((left, right) => right[0].likes - left[0].likes)
    .map(([opinion, item]) => excerpt(item.claim || opinion.text, 44))
    .filter(Boolean))]
    .slice(0, 2);
  const distribution = `共 ${count} 条有效意见：正向 ${counts.positive}、混合 ${counts.mixed}、负向 ${counts.negative}${counts.neutral ? `、中性 ${counts.neutral}` : ''}。`;
  return `${distribution}${tone}${claims.length ? ` 主要反馈包括：${claims.join('；')}。` : ''}`;
};

const topicSummaries = (
  contents: ContentRecord[],
  opinions: OpinionRecord[],
  classifications: ClassificationRecord[]
): ReportTopic[] => {
  const contentById = new Map(contents.map((item) => [item.id, item]));
  const analysis = new Map(classifications.map((item) => [item.opinionId, item]));
  const topicPairs = new Map<string, Array<[OpinionRecord, ClassificationRecord]>>();
  for (const opinion of opinions.filter((item) => item.voiceType === 'viewer')) {
    const item = analysis.get(opinion.id);
    if (!item || !(item.reportEligible ?? item.isValid)) continue;
    for (const topic of item.topics) {
      const pairs = topicPairs.get(topic) ?? [];
      pairs.push([opinion, item]);
      topicPairs.set(topic, pairs);
    }
  }

  return [...topicPairs.entries()].map(([topic, pairs]) => {
    const counts: Record<ReportSentiment, number> = {positive: 0, mixed: 0, negative: 0, neutral: 0};
    const evidence: Record<ReportSentiment, ReportEvidence[]> = {
      positive: [], mixed: [], negative: [], neutral: []
    };
    for (const [opinion, item] of pairs) {
      const sentiment = item.topicSentiments[topic] ?? 'neutral';
      counts[sentiment] += 1;
      const topicEvidence = item.evidence?.find((entry) => entry.topic === topic)?.quote;
      const content = contentById.get(opinion.contentId);
      evidence[sentiment].push({
        id: opinion.id,
        sentiment,
        text: clean(opinion.text),
        evidence: clean(topicEvidence || opinion.text),
        claim: clean(item.claim || ''),
        severity: item.severity,
        confidence: item.confidence,
        likes: opinion.likes,
        replies: opinion.replies,
        authorName: opinion.authorName || '匿名玩家',
        sourceTitle: content?.title || 'B站公开页面',
        sourceUrl: opinion.sourceUrl || opinion.sourcePageUrl || content?.url || '',
        publishedAt: opinion.publishedAt || opinion.publishedAtText
      });
    }
    for (const items of Object.values(evidence)) {
      items.sort((left, right) => right.likes - left.likes || right.severity - left.severity);
    }
    const authors = new Set(pairs.map(([opinion]) => (
      opinion.authorUid || opinion.authorHash || opinion.authorName || opinion.id
    ))).size;
    const sources = new Set(pairs.map(([opinion]) => opinion.contentId)).size;
    const averageSeverity = pairs.reduce((sum, [, item]) => sum + item.severity, 0) / pairs.length;
    const negativeWeight = counts.negative + counts.mixed * 0.6;
    const behaviorFactor = pairs.some(([, item]) => item.behaviorIntents.includes('churn')) ? 2
      : pairs.some(([, item]) => item.behaviorIntents.includes('stop_spending')) ? 1.6
        : pairs.some(([, item]) => item.behaviorIntents.includes('avoid_purchase')) ? 1.3 : 1;
    return {
      topic,
      summary: summaryFor(counts, [...pairs]),
      count: pairs.length,
      positive: counts.positive,
      mixed: counts.mixed,
      negative: counts.negative,
      neutral: counts.neutral,
      sources,
      authors,
      averageSeverity,
      riskScore: authors * (negativeWeight / pairs.length) * averageSeverity * behaviorFactor,
      netSentiment: (counts.positive - counts.negative - counts.mixed * 0.5) / pairs.length,
      reviewStatus: sources >= 3 ? '达到最低复核门槛' : '来源不足三处，建议继续观察',
      evidence
    };
  }).sort((left, right) => right.riskScore - left.riskScore || right.count - left.count);
};

/** Builds the structured report consumed by both the interactive UI and Markdown export. */
export const buildReportData = (
  manifest: RunManifest,
  contents: ContentRecord[],
  opinions: OpinionRecord[],
  classifications: ClassificationRecord[],
  quality: Record<string, unknown>
): ReportData => {
  const analysisMode = quality.analysisMode === 'ai' ? 'ai' : 'rule_demo';
  const topics = topicSummaries(contents, opinions, classifications);
  const leading = topics[0];
  const sourceCount = new Set(contents.map((item) => item.id)).size;
  const validOpinions = numeric(quality.validOpinions);
  const evidenceSufficient = (leading?.sources ?? 0) >= 3;
  const usageCandidate = quality.aiUsage ?? manifest.analysis?.usage;
  const usage = isUsage(usageCandidate) ? usageCandidate : undefined;
  const conclusion = !leading
    ? '本次没有获得足够的有效观众意见，暂不形成玩家反馈结论。'
    : evidenceSufficient
      ? `本次最需要关注“${leading.topic}”。${leading.summary}`
      : `当前观察信号主要集中在“${leading.topic}”，但只覆盖 ${leading.sources} 个来源，证据不足以形成确定结论。`;

  return {
    title: 'B站《火影忍者手游》玩家反馈调查报告',
    runId: manifest.id,
    generatedAt: typeof quality.generatedAt === 'string' ? quality.generatedAt : manifest.updatedAt,
    conclusion,
    sample: {
      sourceCount,
      rawOpinions: numeric(quality.rawOpinions) || opinions.length,
      validOpinions,
      topicCount: topics.length,
      warnings: manifest.counts.warnings,
      confidenceLabel: evidenceSufficient ? '可进入人工复核' : '样本不足，仅供观察',
      confidenceExplanation: evidenceSufficient
        ? '最高风险主题至少覆盖 3 个独立来源，达到最低人工复核门槛；这仍不等于代表全部玩家。'
        : '最高风险主题尚未覆盖 3 个独立来源，当前结论只能作为后续采样线索。'
    },
    topics,
    quality: {
      analysisMode,
      analysisLabel: analysisMode === 'ai'
        ? `${typeof quality.aiModel === 'string' ? quality.aiModel : 'Luna'} AI 结构化筛选`
        : '本地规则演示（未调用 Luna）',
      model: typeof quality.aiModel === 'string' ? quality.aiModel : undefined,
      strongOpinions: analysisMode === 'ai' ? numeric(quality.strongOpinions) : validOpinions,
      weakOpinions: numeric(quality.weakOpinions),
      noiseOpinions: numeric(quality.noiseOpinions),
      duplicateOpinions: numeric(quality.duplicateOpinions),
      localHardNoise: numeric(quality.localHardNoise),
      creatorViewsExcluded: numeric(quality.creatorViewsExcluded),
      cachedAiOpinions: numeric(quality.cachedAiOpinions),
      detailedAiOpinions: numeric(quality.detailedAiOpinions),
      usage,
      usageExplanation: analysisMode === 'rule_demo'
        ? '演示模式使用本地规则，未调用 Luna，因此 Token 与模型费用均为 0。'
        : usage
          ? 'Token 来自本次报告生成期间 OpenAI Responses API 返回的实际 usage；美元金额按记录的模型公开单价估算，实际账单可能略有差异。'
          : '这是一份旧版报告，当时尚未保存 API usage，因此无法可靠还原 Token 与费用。重新用 Luna 分析后即可记录。'
    },
    limitations: [
      '热门优先采样不代表全部玩家，不能外推为总体民意。',
      '主题允许多选，因此各主题意见数之和可能超过有效意见总数。',
      '创作者标题与观众评论分开保存；主题只统计有效观众意见。',
      analysisMode === 'ai'
        ? '正式意见由 Luna 结合视频语境、当前评论和父评论进行结构化筛选；AI 结果仍需定期用标准答案集评测。'
        : '当前为本地规则演示结果，不能用于正式产品决策。',
      '采集器只读取公开可见页面，不绕过登录、验证码或平台访问限制。'
    ]
  };
};

const evidenceLines = (topic: ReportTopic, sentiment: ReportSentiment) => {
  const items = topic.evidence[sentiment];
  if (items.length === 0) return ['- 暂无此类意见。'];
  return items.map((item) => {
    const source = excerpt(item.sourceTitle, 34);
    const link = item.sourceUrl ? `（[查看原文](${item.sourceUrl})）` : '';
    return `- “${excerpt(item.text, 180)}” — ${source}；${item.likes} 赞；严重度 ${item.severity}/5 ${link}`;
  });
};

/** Renders the same complete report as readable, portable Markdown. */
export const buildReport = (
  manifest: RunManifest,
  contents: ContentRecord[],
  opinions: OpinionRecord[],
  classifications: ClassificationRecord[],
  quality: Record<string, unknown>
) => {
  const data = buildReportData(manifest, contents, opinions, classifications, quality);
  const usage = data.quality.usage;
  const stopLabel = manifest.stopReason === 'user_finalized' ? '用户提前结束'
    : manifest.stopReason === 'budget_exhausted' ? '达到采集时限' : '候选来源处理完成';
  const lines = [
    `# ${data.title}`,
    '',
    `> 调查：${manifest.request.name}  `,
    `> 采集执行时间：${Math.round(manifest.activeElapsedMs / 1000)} 秒；内容范围：最近 ${manifest.request.contentWindowDays} 天  `,
    `> 停止原因：${stopLabel}；数据模式：${manifest.request.mode === 'demo' ? '虚构演示数据' : 'B站公开页面采样'}  `,
    `> 分析方式：${data.quality.analysisLabel}  `,
    `> 运行 ID：\`${manifest.id}\``,
    '',
    '## 一句话结论',
    '',
    data.conclusion,
    '',
    '## 样本概况',
    '',
    `- 独立内容来源：${data.sample.sourceCount} 个`,
    `- 原始意见：${data.sample.rawOpinions} 条`,
    `- 进入报告的有效意见：${data.sample.validOpinions} 条`,
    `- 主题数量：${data.sample.topicCount} 个`,
    `- 质量判断：${data.sample.confidenceLabel}。${data.sample.confidenceExplanation}`,
    '',
    '## 主题总览',
    '',
    '| 主题 | 大体总结 | 正向 | 混合 | 负向 | 中性 | 来源 | 详情 |',
    '|---|---|---:|---:|---:|---:|---:|---|'
  ];
  if (data.topics.length === 0) lines.push('| 暂无有效数据 | — | 0 | 0 | 0 | 0 | 0 | — |');
  for (const topic of data.topics) {
    lines.push(`| ${topic.topic} | ${excerpt(topic.summary, 86)} | ${topic.positive} | ${topic.mixed} | ${topic.negative} | ${topic.neutral} | ${topic.sources} | [查看详情](#主题${topic.topic}) |`);
  }

  lines.push('', '## 主题详情', '');
  for (const topic of data.topics) {
    lines.push(
      `### 主题：${topic.topic}`,
      '',
      topic.summary,
      '',
      `- 证据范围：${topic.authors} 名独立作者、${topic.sources} 个来源`,
      `- 平均严重度：${topic.averageSeverity.toFixed(1)}/5；净态度：${percent(topic.netSentiment)}`,
      `- 复核判断：${topic.reviewStatus}`,
      '',
      `#### 正向意见（${topic.positive}）`,
      '',
      ...evidenceLines(topic, 'positive'),
      '',
      `#### 混合意见（${topic.mixed}）`,
      '',
      ...evidenceLines(topic, 'mixed'),
      '',
      `#### 负向意见（${topic.negative}）`,
      '',
      ...evidenceLines(topic, 'negative')
    );
    if (topic.neutral) lines.push('', `#### 中性意见（${topic.neutral}）`, '', ...evidenceLines(topic, 'neutral'));
    lines.push('');
  }

  lines.push('## 数据质量与 Luna 用量', '');
  if (data.quality.analysisMode === 'rule_demo') {
    lines.push('- Luna 调用：0 次', '- Token：0', '- 预估费用：$0.00 美元');
  } else if (usage) {
    const cost = usage.estimatedCostUsd === undefined ? '当前模型暂无内置单价，无法估算' : `约 $${usage.estimatedCostUsd.toFixed(4)} 美元`;
    lines.push(
      `- Luna API 调用：${usage.requestCount} 次`,
      `- 输入 Token：${usage.inputTokens.toLocaleString('zh-CN')}（其中缓存输入 ${usage.cachedInputTokens.toLocaleString('zh-CN')}）`,
      `- 输出 Token：${usage.outputTokens.toLocaleString('zh-CN')}（其中推理 Token ${usage.reasoningTokens.toLocaleString('zh-CN')}）`,
      `- 总 Token：${usage.totalTokens.toLocaleString('zh-CN')}`,
      `- 预估费用：${cost}`
    );
    if (usage.pricing) lines.push(`- 估算单价：输入 $${usage.pricing.inputPerMillion}/百万 Token，缓存输入 $${usage.pricing.cachedInputPerMillion}/百万 Token，输出 $${usage.pricing.outputPerMillion}/百万 Token（核对日期 ${usage.pricing.checkedAt}）`);
  } else {
    lines.push('- Token 与费用：历史报告未记录，无法可靠还原；重新用 Luna 分析后即可记录。');
  }
  lines.push(
    `- 强洞察：${data.quality.strongOpinions} 条（进入报告）`,
    `- 弱信号：${data.quality.weakOpinions} 条（保留但不进入结论）`,
    `- 无产品参考价值：${data.quality.noiseOpinions} 条`,
    '',
    data.quality.usageExplanation,
    '',
    '## 口径与限制',
    '',
    ...data.limitations.map((item) => `- ${item}`),
    ''
  );
  return lines.join('\n');
};
