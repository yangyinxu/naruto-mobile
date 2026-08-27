import {
  ClassificationRecord,
  ContentRecord,
  OpinionRecord,
  RunManifest
} from '../domain/types';

interface TopicSummary {
  topic: string;
  count: number;
  positive: number;
  negative: number;
  neutral: number;
  sources: number;
  authors: number;
  averageSeverity: number;
  riskScore: number;
  netSentiment: number;
}

const percent = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`;
const quote = (text: string) => {
  const clean = text.replace(/\|/g, '／').replace(/\s+/g, ' ').trim();
  return clean.length <= 70 ? clean : `${clean.slice(0, 69)}…`;
};

const topicSummaries = (
  opinions: OpinionRecord[],
  classifications: ClassificationRecord[]
): TopicSummary[] => {
  const analysis = new Map(classifications.map((item) => [item.opinionId, item]));
  const topicPairs = new Map<string, Array<[OpinionRecord, ClassificationRecord]>>();
  for (const opinion of opinions.filter((item) => item.voiceType === 'viewer')) {
    const item = analysis.get(opinion.id);
    if (!item?.isValid) continue;
    for (const topic of item.topics) {
      const pairs = topicPairs.get(topic) ?? [];
      pairs.push([opinion, item]);
      topicPairs.set(topic, pairs);
    }
  }
  return [...topicPairs.entries()].map(([topic, pairs]) => {
    let positive = 0;
    let negative = 0;
    let neutral = 0;
    for (const [, item] of pairs) {
      const sentiment = item.topicSentiments[topic] ?? 'neutral';
      if (sentiment === 'positive') positive += 1;
      else if (sentiment === 'negative' || sentiment === 'mixed') negative += 1;
      else neutral += 1;
    }
    const authors = new Set(pairs.map(([opinion]) => (
      opinion.authorUid || opinion.authorHash || opinion.authorName || opinion.id
    ))).size;
    const sources = new Set(pairs.map(([opinion]) => opinion.contentId)).size;
    const averageSeverity = pairs.reduce((sum, [, item]) => sum + item.severity, 0) / pairs.length;
    const negativeRatio = negative / pairs.length;
    const behaviorFactor = pairs.some(([, item]) => item.behaviorIntents.includes('churn')) ? 2
      : pairs.some(([, item]) => item.behaviorIntents.includes('stop_spending')) ? 1.6
        : pairs.some(([, item]) => item.behaviorIntents.includes('avoid_purchase')) ? 1.3 : 1;
    return {
      topic,
      count: pairs.length,
      positive,
      negative,
      neutral,
      sources,
      authors,
      averageSeverity,
      riskScore: authors * negativeRatio * averageSeverity * behaviorFactor,
      netSentiment: (positive - negative) / pairs.length
    };
  }).sort((left, right) => right.riskScore - left.riskScore || right.count - left.count);
};

/** Renders an evidence-gated Markdown report that remains readable outside the app. */
export const buildReport = (
  manifest: RunManifest,
  contents: ContentRecord[],
  opinions: OpinionRecord[],
  classifications: ClassificationRecord[],
  quality: Record<string, unknown>
) => {
  const topics = topicSummaries(opinions, classifications);
  const validViewerOpinions = opinions.filter((opinion) => opinion.voiceType === 'viewer'
    && classifications.find((item) => item.opinionId === opinion.id)?.isValid);
  const leading = topics[0];
  const evidenceSufficient = (leading?.sources ?? 0) >= 3;
  const conclusion = !leading
    ? '本次没有获得足够的有效观众意见，暂不形成玩家反馈结论。'
    : evidenceSufficient
      ? `本次风险排序最高的主题是“${leading.topic}”，共 ${leading.count} 条有效意见，覆盖 ${leading.sources} 个独立来源。`
      : `当前观察信号主要集中在“${leading.topic}”，但只覆盖 ${leading.sources} 个来源，证据不足以形成确定结论。`;
  const stopLabel = manifest.stopReason === 'user_finalized' ? '用户提前结束'
    : manifest.stopReason === 'budget_exhausted' ? '达到采集时限' : '候选来源处理完成';
  const lines = [
    '# B站《火影忍者手游》玩家反馈调查报告',
    '',
    `> 调查：${manifest.request.name}  `,
    `> 采集执行时间：${Math.round(manifest.activeElapsedMs / 1000)} 秒；内容范围：最近 ${manifest.request.contentWindowDays} 天  `,
    `> 停止原因：${stopLabel}；数据模式：${manifest.request.mode === 'demo' ? '虚构演示数据' : 'B站公开页面采样'}  `,
    `> 运行 ID：\`${manifest.id}\``,
    '',
    '## 一句话结论',
    '',
    conclusion,
    '',
    '## 样本概况',
    '',
    `- 独立内容来源：${new Set(contents.map((item) => item.id)).size} 个`,
    `- 原始意见：${opinions.length} 条`,
    `- 有效观众意见：${validViewerOpinions.length} 条`,
    `- 采集警告：${manifest.counts.warnings} 条`,
    `- 质量判断：${evidenceSufficient ? '达到三来源最低复核门槛' : '样本不足，仅供观察'}`,
    '',
    '## 主题总览',
    '',
    '| 主题 | 意见数 | 正/负/中 | 净态度 | 来源数 | 风险分 |',
    '|---|---:|---:|---:|---:|---:|'
  ];
  if (topics.length === 0) lines.push('| 暂无有效数据 | 0 | 0/0/0 | — | 0 | 0.0 |');
  for (const item of topics) {
    lines.push(`| ${item.topic} | ${item.count} | ${item.positive}/${item.negative}/${item.neutral} | ${percent(item.netSentiment)} | ${item.sources} | ${item.riskScore.toFixed(1)} |`);
  }
  lines.push('', '## 风险问题卡片', '');
  const analysis = new Map(classifications.map((item) => [item.opinionId, item]));
  topics.slice(0, 3).forEach((topic, index) => {
    const examples = opinions
      .filter((opinion) => analysis.get(opinion.id)?.topics.includes(topic.topic))
      .sort((left, right) => right.likes - left.likes)
      .slice(0, 3);
    lines.push(
      `### ${index + 1}. ${topic.topic}`,
      '',
      `- 证据：${topic.authors} 名独立作者、${topic.sources} 个来源`,
      `- 态度：正向 ${topic.positive}，负向或混合 ${topic.negative}，平均严重度 ${topic.averageSeverity.toFixed(1)}/5`,
      `- 判断：${topic.sources >= 3 ? '可进入人工复核' : '来源不足三处，继续观察'}`,
      `- 代表性意见：${examples.length ? examples.map((item) => `“${quote(item.text)}”`).join('；') : '暂无'}`,
      ''
    );
  });
  if (topics.length === 0) lines.push('暂无可生成的问题卡片。', '');
  lines.push(
    '## 口径与限制',
    '',
    '- 热门优先采样不代表全部玩家，不能外推为总体民意。',
    '- 主题允许多选，因此各主题意见数之和可能超过有效意见总数。',
    '- 创作者标题与观众评论分开保存；主题表只统计有效观众意见。',
    '- 当前使用可审计的规则分类器，正式决策前应抽样人工复核。',
    '- 采集器只读取公开可见页面，不绕过登录、验证码或平台访问限制。',
    '',
    '## 质量明细',
    '',
    '```json',
    JSON.stringify(quality, null, 2),
    '```',
    ''
  );
  return lines.join('\n');
};
