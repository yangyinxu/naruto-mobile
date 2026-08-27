import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {api} from '../lib/api';
import {RunManifest} from '../types';
import {RecordsView} from './RecordsView';

const run: RunManifest = {
  id: '20260827T120000-abcd1234',
  state: 'completed',
  request: {
    name: '完整记录测试', durationMinutes: 5, contentWindowDays: 30,
    keywords: ['火影忍者手游'], includeVideos: true, includeDynamics: false,
    mode: 'live', browserVisible: true, browserWindowCount: 1, maxSources: 20
  },
  createdAt: '2026-08-27T12:00:00.000Z', updatedAt: '2026-08-27T12:05:00.000Z',
  activeElapsedMs: 300_000, statusMessage: '调查完成',
  counts: {candidates: 2, contents: 1, opinions: 1, validOpinions: 1, sources: 1, warnings: 0},
  reportReady: true
};

afterEach(() => vi.restoreAllMocks());

describe('RecordsView', () => {
  it('shows a traceable opinion and searches complete records', async () => {
    const records = vi.spyOn(api, 'runRecords').mockResolvedValue({
      kind: 'opinions', total: 1, offset: 0, limit: 50,
      records: [{
        contentTitle: '火影手游测试视频',
        record: {
          id: 'opinion-1', contentId: 'BV1', contentType: 'video', sourceType: 'comment',
          voiceType: 'viewer', text: '服务器有点卡', collectedAt: '2026-08-27T12:00:00.000Z',
          authorUid: '123456', authorName: '玩家甲', sourceRecordId: '998877', likes: 3, replies: 1,
          sourcePageUrl: 'https://www.bilibili.com/video/BV1',
          sourceUrl: 'https://www.bilibili.com/video/BV1?comment_on=1&comment_root_id=998877'
        }
      }]
    });
    render(<RecordsView run={run} onBack={vi.fn()} onError={vi.fn()}/>);
    expect(await screen.findByText('玩家甲')).toBeVisible();
    expect(screen.getByText('服务器有点卡')).toBeVisible();
    expect(screen.getByText('998877')).toBeVisible();
    expect(screen.getByRole('link', {name: /打开原评论/})).toHaveAttribute('href', expect.stringContaining('comment_root_id'));

    fireEvent.change(screen.getByLabelText('搜索完整记录'), {target: {value: '玩家甲'}});
    fireEvent.click(screen.getByRole('button', {name: '搜索'}));
    await waitFor(() => expect(records).toHaveBeenLastCalledWith(run.id, 'opinions', 0, 50, '玩家甲'));
  });
});
