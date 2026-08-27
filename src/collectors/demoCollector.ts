import {
  CandidateContent,
  CollectionContext,
  CollectionResult,
  Collector,
  ContentRecord,
  OpinionRecord
} from '../domain/types';
import {delay, stableId} from './collectorUtils';

const samples = [
  {
    id: 'BVDEMO001',
    title: '火影忍者手游决斗场：本周延迟与替身判定观察',
    opinions: [
      '土豆服务器，晋级赛替身又按不出来，真想退游',
      '移动网络打决斗场延迟太离谱，希望能显示网络状态',
      '又瞬移了'
    ]
  },
  {
    id: 'BVDEMO002',
    title: '火影手游新忍者实战：强度是否超标',
    opinions: [
      '这个忍者做得真帅，但是强度也太超标了',
      '阴间是阴间，但上分真好用，必抽',
      '刚抽到就怕等削，不公平'
    ]
  },
  {
    id: 'BVDEMO003',
    title: '火影忍者手游服务器又怎么了',
    opinions: [
      '今天组织里三个人都掉线，服务器真的差',
      '卡顿后直接闪退，停止充值了',
      '服务器延迟导致匹配失败'
    ]
  },
  {
    id: 'BVDEMO004',
    title: '火影手游高招值不值得抽',
    opinions: [
      '高招首付性价比不错，金币够就准备抽',
      '做了一年金币，刚抽到就削，真的失望',
      '我是V0，这次保底成本太高，不抽'
    ]
  },
  {
    id: 'BVDEMO005',
    title: '火影忍者手游八周年回流体验',
    opinions: [
      '刚回坑，活动福利不错，但追赶资源还是难',
      '玩了八年，角色还原还是很有诚意',
      '新手日常太多，希望减少重复玩法'
    ]
  }
] as const;

const outcomeForDirective = (
  directive: ReturnType<CollectionContext['callbacks']['getDirective']>
): CollectionResult['outcome'] | null => {
  if (directive === 'pause') return 'paused';
  if (directive === 'finalize') return 'finalized';
  if (directive === 'budget_exhausted') return 'budget_exhausted';
  return null;
};

/** Produces realistic local fixtures so first-time users can verify the full workflow. */
export class DemoCollector implements Collector {
  async collect(context: CollectionContext): Promise<CollectionResult> {
    const {callbacks, checkpoint} = context;
    if (checkpoint.pendingCandidates.length === 0 && checkpoint.seenContentIds.length === 0) {
      await callbacks.onState('discovering', '正在发现演示内容…');
      checkpoint.pendingCandidates = samples.map((item, index): CandidateContent => ({
        id: item.id,
        type: 'video',
        url: `https://www.bilibili.com/video/${item.id}`,
        discoveryUrl: 'demo://popular-search/fire-ninja-mobile',
        title: item.title,
        discoveryKeyword: '火影忍者手游',
        discoveryRank: index + 1,
        popularityText: `${120 - index * 17}万播放`
      }));
      await callbacks.onCandidates(checkpoint.pendingCandidates);
      await callbacks.onCheckpoint(checkpoint);
      await delay(250);
    }

    await callbacks.onState('collecting', '正在采集演示视频和评论…');
    while (checkpoint.pendingCandidates.length > 0) {
      const directiveOutcome = outcomeForDirective(callbacks.getDirective());
      if (directiveOutcome) return {outcome: directiveOutcome, checkpoint};

      const candidate = checkpoint.pendingCandidates[0];
      const sample = samples.find((item) => item.id === candidate.id);
      if (!sample) {
        checkpoint.pendingCandidates.shift();
        continue;
      }
      const now = new Date();
      const content: ContentRecord = {
        ...candidate,
        runId: context.manifest.id,
        resolvedUrl: candidate.url,
        description: '这是用于验证本地调查流程的虚构演示数据。',
        publishedAt: new Date(now.getTime() - candidate.discoveryRank * 86400000).toISOString(),
        collectedAt: now.toISOString(),
        metrics: {views: (130 - candidate.discoveryRank * 17) * 10000, comments: 300 + candidate.discoveryRank * 80}
      };
      await callbacks.onContent(content);

      const creatorOpinion: OpinionRecord = {
        id: stableId(candidate.id, 'creator', candidate.title),
        runId: context.manifest.id,
        contentId: candidate.id,
        contentType: 'video',
        sourceType: 'creator_view',
        voiceType: 'creator',
        text: candidate.title,
        publishedAt: content.publishedAt,
        collectedAt: now.toISOString(),
        likes: 0,
        replies: 0,
        sourcePageUrl: candidate.url,
        sourceUrl: candidate.url
      };
      if (!checkpoint.seenOpinionIds.includes(creatorOpinion.id)) {
        await callbacks.onOpinion(creatorOpinion);
        checkpoint.seenOpinionIds.push(creatorOpinion.id);
      }
      for (const [index, text] of sample.opinions.entries()) {
        const opinion: OpinionRecord = {
          id: stableId(candidate.id, String(index), text),
          runId: context.manifest.id,
          contentId: candidate.id,
          contentType: 'video',
          sourceType: 'comment',
          voiceType: 'viewer',
          text,
          publishedAt: new Date(now.getTime() - index * 3600000).toISOString(),
          collectedAt: now.toISOString(),
          authorUid: `DEMO-UID-${candidate.discoveryRank}-${index + 1}`,
          authorName: `演示玩家${candidate.discoveryRank}-${index + 1}`,
          authorProfileUrl: `demo://author/${candidate.discoveryRank}-${index + 1}`,
          sourceRecordId: `DEMO-COMMENT-${candidate.discoveryRank}-${index + 1}`,
          likes: Math.max(12, 980 - candidate.discoveryRank * 100 - index * 170),
          replies: Math.max(0, 60 - index * 16),
          sourcePageUrl: candidate.url,
          sourceUrl: `${candidate.url}?comment_on=1&comment_root_id=DEMO-COMMENT-${candidate.discoveryRank}-${index + 1}`
        };
        if (!checkpoint.seenOpinionIds.includes(opinion.id)) {
          await callbacks.onOpinion(opinion);
          checkpoint.seenOpinionIds.push(opinion.id);
        }
      }
      checkpoint.seenContentIds.push(candidate.id);
      checkpoint.pendingCandidates.shift();
      await callbacks.onCheckpoint(checkpoint);
      await delay(350);
    }
    return {outcome: 'source_exhausted', checkpoint};
  }
}
