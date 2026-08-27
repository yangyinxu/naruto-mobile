import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {RunManifest} from '../types';
import {History} from './History';

const run: RunManifest = {
  id: '20260827T120000-abcd1234',
  state: 'completed',
  request: {
    name: '历史记录入口测试',
    durationMinutes: 5,
    contentWindowDays: 30,
    keywords: ['火影忍者手游'],
    includeVideos: true,
    includeDynamics: false,
    mode: 'live',
    browserVisible: true,
    browserWindowCount: 1,
    maxSources: 20
  },
  createdAt: '2026-08-27T12:00:00.000Z',
  updatedAt: '2026-08-27T12:05:00.000Z',
  activeElapsedMs: 300_000,
  statusMessage: '调查和报告已经完成。',
  counts: {candidates: 4, contents: 3, opinions: 12, validOpinions: 10, sources: 3, warnings: 0},
  reportReady: true
};

describe('History', () => {
  it('offers complete record browsing and folder opening for every run', () => {
    const onBrowse = vi.fn();
    const onOpenFolder = vi.fn();
    render(<History runs={[run]} onOpen={vi.fn()} onBrowse={onBrowse} onOpenFolder={onOpenFolder}/>);
    fireEvent.click(screen.getByRole('button', {name: /浏览完整记录/}));
    expect(onBrowse).toHaveBeenCalledWith(run);
    fireEvent.click(screen.getByRole('button', {name: /打开 历史记录入口测试 的完整记录文件夹/}));
    expect(onOpenFolder).toHaveBeenCalledWith(run);
  });
});
