import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeResearchRequest, RequestValidationError} from '../src/domain/validation';

test('normalizes the beginner defaults and deduplicates keywords', () => {
  const request = normalizeResearchRequest({
    keywords: ['火影忍者手游', ' 火影忍者手游 ', '决斗场']
  });
  assert.equal(request.durationMinutes, 5);
  assert.equal(request.contentWindowDays, 30);
  assert.deepEqual(request.keywords, ['火影忍者手游', '决斗场']);
  assert.equal(request.mode, 'live');
  assert.equal(request.browserWindowCount, 1);
});

test('rejects empty sources and unsafe time bounds', () => {
  assert.throws(() => normalizeResearchRequest({keywords: ['火影手游'], includeVideos: false, includeDynamics: false}), RequestValidationError);
  assert.throws(() => normalizeResearchRequest({keywords: ['火影手游'], durationMinutes: 0}), /采集时间/);
  assert.throws(() => normalizeResearchRequest({keywords: ['火影手游'], browserWindowCount: 5}), /并行窗口数/);
});

test('accepts up to four parallel browser windows', () => {
  const request = normalizeResearchRequest({keywords: ['火影手游'], browserWindowCount: 4});
  assert.equal(request.browserWindowCount, 4);
});
