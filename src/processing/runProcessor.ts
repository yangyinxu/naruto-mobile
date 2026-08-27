import {FileRunStore} from '../infrastructure/fileRunStore';
import {RunManifest} from '../domain/types';
import {cleanOpinions} from './cleaner';
import {RuleClassifier} from './ruleClassifier';
import {buildReport} from './reporter';

/** Rebuilds every derived artifact from immutable raw JSONL. */
export const processRun = async (store: FileRunStore, manifest: RunManifest) => {
  const [contents, rawOpinions, classifier] = await Promise.all([
    store.readContents(manifest.id),
    store.readOpinions(manifest.id),
    RuleClassifier.load()
  ]);
  const cleaning = cleanOpinions(rawOpinions);
  const contentById = new Map(contents.map((item) => [item.id, item]));
  const classifications = cleaning.opinions.flatMap((opinion) => {
    const content = contentById.get(opinion.contentId);
    return content ? [classifier.classify(opinion, content)] : [];
  });
  const opinionById = new Map(cleaning.opinions.map((item) => [item.id, item]));
  const validClassifications = classifications.filter((item) => item.isValid);
  const validViewerOpinions = validClassifications
    .filter((item) => opinionById.get(item.opinionId)?.voiceType === 'viewer').length;
  const validCreatorViews = validClassifications.length - validViewerOpinions;
  const quality = {
    generatedAt: new Date().toISOString(),
    classifierVersion: classifier.version,
    rawContents: contents.length,
    rawOpinions: rawOpinions.length,
    processedOpinions: cleaning.opinions.length,
    validOpinions: validViewerOpinions,
    validCreatorViews,
    invalidOpinions: classifications.length - validClassifications.length,
    duplicateOpinions: cleaning.duplicateCount,
    rejected: cleaning.rejected,
    note: manifest.request.mode === 'demo'
      ? '演示数据为虚构样例，不能作为真实玩家反馈结论。'
      : '规则分类结果必须经过人工抽检后用于产品决策。'
  };
  const report = buildReport(manifest, contents, cleaning.opinions, classifications, quality);
  await Promise.all([
    store.writeProcessedOpinions(manifest.id, cleaning.opinions),
    store.writeClassifications(manifest.id, classifications),
    store.writeQualityReport(manifest.id, quality),
    store.writeReport(manifest.id, report)
  ]);
  return {
    validOpinions: validViewerOpinions,
    sourceCount: new Set(contents.map((item) => item.id)).size,
    rawOpinionCount: rawOpinions.length,
    rawContentCount: contents.length,
    report
  };
};
