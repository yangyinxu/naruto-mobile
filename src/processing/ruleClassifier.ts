import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ClassificationRecord, ContentRecord, OpinionRecord} from '../domain/types';

interface TaxonomyConfig {
  version: string;
  topics: Record<string, string[]>;
  positiveWords: string[];
  negativeWords: string[];
  behaviorIntents: Record<string, string[]>;
  playerSegments: Record<string, string[]>;
}

interface RelevanceConfig {
  version: string;
  directTerms: string[];
  strongMobileTerms: string[];
  gameContextTerms: string[];
  excludeTerms: string[];
  noiseTerms: string[];
}

const loadJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const matches = (text: string, terms: string[]) => {
  const folded = text.toLocaleLowerCase();
  return terms.filter((term) => folded.includes(term.toLocaleLowerCase()));
};

/** Provides an auditable baseline classifier before a gold set justifies model integration. */
export class RuleClassifier {
  private constructor(
    private readonly taxonomy: TaxonomyConfig,
    private readonly relevance: RelevanceConfig
  ) {}

  static async load(configDirectory = join(process.cwd(), 'config')) {
    const [taxonomy, relevance] = await Promise.all([
      loadJson<TaxonomyConfig>(join(configDirectory, 'taxonomy.json')),
      loadJson<RelevanceConfig>(join(configDirectory, 'relevance.json'))
    ]);
    return new RuleClassifier(taxonomy, relevance);
  }

  get version() {
    return `rule:${this.taxonomy.version}/${this.relevance.version}`;
  }

  private relevanceResult(
    text: string,
    content: ContentRecord,
    hasOpinionSignal: boolean,
    creatorView: boolean
  ) {
    const sourceText = `${content.title} ${content.description}`;
    const direct = matches(text, this.relevance.directTerms);
    const strong = matches(text, this.relevance.strongMobileTerms);
    const game = matches(text, this.relevance.gameContextTerms);
    const excluded = matches(text, this.relevance.excludeTerms);
    const sourceDirect = matches(sourceText, this.relevance.directTerms);
    const sourceStrong = matches(sourceText, this.relevance.strongMobileTerms);
    const sourceGame = matches(sourceText, this.relevance.gameContextTerms);
    const sourceExcluded = matches(sourceText, this.relevance.excludeTerms);
    const sourceRelated = sourceDirect.length > 0 || sourceStrong.length > 0 || sourceGame.length >= 2;
    let score = direct.length ? 0.98
      : strong.length >= 2 ? 0.88
        : strong.length ? 0.8
          : game.length >= 2 ? 0.72
            : game.length ? 0.6
              : creatorView && sourceRelated ? 0.95
                : hasOpinionSignal && sourceRelated ? 0.72
                  : sourceRelated ? 0.32 : 0.12;
    if (excluded.length && !strong.length && !direct.length) score = Math.min(score, 0.1);
    if (excluded.length && (strong.length || direct.length)) score = Math.min(score, 0.82);
    if (sourceExcluded.length && !direct.length && !strong.length) score = Math.min(score, 0.2);
    return {
      score,
      level: score >= 0.8 ? 'high' as const : score >= 0.5 ? 'medium' as const : 'low' as const,
      terms: [...direct, ...strong, ...game, ...excluded],
      sourceTerms: [...sourceDirect, ...sourceStrong, ...sourceGame, ...sourceExcluded]
    };
  }

  private sentiment(text: string) {
    const positive = matches(text, this.taxonomy.positiveWords).length;
    const negative = matches(text, this.taxonomy.negativeWords).length;
    if (positive && negative) return 'mixed' as const;
    if (negative) return 'negative' as const;
    if (positive) return 'positive' as const;
    return 'neutral' as const;
  }

  classify(opinion: OpinionRecord, content: ContentRecord): ClassificationRecord {
    const text = opinion.normalizedText || opinion.text;
    const matchedTopics = Object.fromEntries(Object.entries(this.taxonomy.topics)
      .map(([topic, terms]) => [topic, matches(text, terms)])
      .filter(([, found]) => (found as string[]).length)) as Record<string, string[]>;
    const behaviorIntents = Object.entries(this.taxonomy.behaviorIntents)
      .filter(([, terms]) => matches(text, terms).length)
      .map(([intent]) => intent);
    const relevance = this.relevanceResult(
      text,
      content,
      Object.keys(matchedTopics).length > 0 || behaviorIntents.length > 0,
      opinion.voiceType === 'creator'
    );
    const topics = Object.keys(matchedTopics);
    if (topics.length === 0 && relevance.score >= 0.5) topics.push('其他');
    const generalSentiment = this.sentiment(text);
    const topicSentiments = Object.fromEntries(topics.map((topic) => [topic, generalSentiment]));
    const playerSegment = Object.entries(this.taxonomy.playerSegments)
      .find(([, terms]) => matches(text, terms).length)?.[0] ?? 'unknown';
    const noise = matches(text, this.relevance.noiseTerms);
    let isValid = relevance.score >= 0.5;
    let invalidReason: string | undefined;
    if (noise.length && text.length <= 12) {
      isValid = false;
      invalidReason = 'low_value_noise';
    } else if (!isValid) {
      invalidReason = 'low_relevance';
    }

    const severeBehavior = behaviorIntents.includes('churn') || behaviorIntents.includes('stop_spending');
    const actionableTopic = topics.some((topic) => ['技术质量', '公平性', '运营沟通'].includes(topic));
    const severity = severeBehavior ? 5
      : actionableTopic && ['negative', 'mixed'].includes(generalSentiment) ? 4
        : ['negative', 'mixed'].includes(generalSentiment) ? 3
          : generalSentiment === 'positive' ? 1 : 2;
    const emotion = generalSentiment === 'positive' ? 'appreciation' as const
      : generalSentiment === 'negative' ? 'frustration' as const
        : generalSentiment;
    const stance = text.includes('建议') || text.includes('希望') ? 'suggestion' as const
      : ['negative', 'mixed'].includes(generalSentiment) ? 'complaint' as const
        : generalSentiment === 'positive' ? 'praise' as const : 'discussion' as const;
    const actionability = behaviorIntents.length || (actionableTopic && severity >= 4)
      ? 'high' as const : topics.length && topics[0] !== '其他' ? 'medium' as const : 'low' as const;

    return {
      opinionId: opinion.id,
      relevanceScore: relevance.score,
      relevanceLevel: relevance.level,
      isValid,
      invalidReason,
      topics,
      topicSentiments,
      emotion,
      stance,
      severity,
      behaviorIntents,
      playerSegment,
      actionability,
      confidence: Math.min(0.95, 0.5 + Object.keys(matchedTopics).length * 0.06 + Math.abs(relevance.score - 0.5)),
      classifierVersion: this.version,
      matchedTerms: {
        relevance: relevance.terms,
        sourceRelevance: relevance.sourceTerms,
        ...matchedTopics,
        ...(noise.length ? {noise} : {})
      }
    };
  }
}
