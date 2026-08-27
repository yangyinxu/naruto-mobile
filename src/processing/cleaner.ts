import {OpinionRecord} from '../domain/types';

const urlPattern = /https?:\/\/\S+/giu;
const mentionPattern = /(^|\s)@[\w\-\u4e00-\u9fff]+/gu;
const visiblePattern = /[\p{L}\p{N}]/u;

export const normalizeText = (text: string) => text
  .normalize('NFKC')
  .replace(urlPattern, ' [链接] ')
  .replace(mentionPattern, '$1[用户]')
  .replace(/\s+/g, ' ')
  .trim();

export interface CleaningResult {
  opinions: OpinionRecord[];
  rejected: Array<{opinionId: string; reason: string}>;
  duplicateCount: number;
}

/** Normalizes public text while keeping raw JSONL immutable for auditability. */
export const cleanOpinions = (opinions: OpinionRecord[]): CleaningResult => {
  const kept: OpinionRecord[] = [];
  const rejected: CleaningResult['rejected'] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  for (const opinion of opinions) {
    const normalizedText = normalizeText(opinion.text);
    if (!normalizedText) {
      rejected.push({opinionId: opinion.id, reason: 'empty_after_cleaning'});
      continue;
    }
    if (!visiblePattern.test(normalizedText)) {
      rejected.push({opinionId: opinion.id, reason: 'emoji_or_punctuation_only'});
      continue;
    }
    const authorKey = opinion.authorUid || opinion.authorHash || opinion.authorName || 'anonymous';
    const key = `${opinion.contentId}\0${authorKey}\0${normalizedText.toLocaleLowerCase()}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      rejected.push({opinionId: opinion.id, reason: 'exact_duplicate'});
      continue;
    }
    seen.add(key);
    kept.push({...opinion, normalizedText});
  }
  return {opinions: kept, rejected, duplicateCount};
};
