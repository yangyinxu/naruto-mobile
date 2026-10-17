import assert from 'node:assert/strict';
import test from 'node:test';
import {inContentWindow, parseBilibiliDate} from '../../src/domain/publishedDate';

// 2026-10-17 23:22 China Standard Time.
const now = Date.UTC(2026, 9, 17, 15, 22);

test('parses Bilibili relative, named, full and current-year publish labels in China time', () => {
  assert.equal(parseBilibiliDate('刚刚', now), new Date(now).toISOString());
  assert.equal(parseBilibiliDate('· 3天前', now), new Date(now - 3 * 86_400_000).toISOString());
  assert.equal(parseBilibiliDate('5小时前', now), new Date(now - 5 * 3_600_000).toISOString());
  assert.equal(parseBilibiliDate('昨天', now), '2026-10-15T16:00:00.000Z');
  assert.equal(parseBilibiliDate('前天 08:30', now), '2026-10-15T00:30:00.000Z');
  assert.equal(parseBilibiliDate('2025-03-12', now), '2025-03-11T16:00:00.000Z');
  assert.equal(parseBilibiliDate('编辑于 2025年10月14日 18:12', now), '2025-10-14T10:12:00.000Z');
  assert.equal(parseBilibiliDate('9月29日', now), '2026-09-28T16:00:00.000Z');
  assert.equal(parseBilibiliDate('10-14', now), '2026-10-13T16:00:00.000Z');
  // A month/day later than today belongs to the previous year.
  assert.equal(parseBilibiliDate('12-25', now), '2025-12-24T16:00:00.000Z');
});

test('unrecognized or impossible labels stay unknown', () => {
  for (const value of [undefined, '', '火影手游', '06:03', '640万', '13-45', '2025-13-01']) {
    assert.equal(parseBilibiliDate(value, now), undefined, String(value));
  }
});

test('the content window rejects unknown and older dates and gives day labels one day of slack', () => {
  assert.equal(inContentWindow(undefined, 30, {now}), false);
  assert.equal(inContentWindow('not a date', 30, {now}), false);
  assert.equal(inContentWindow('2025-10-01T00:00:00.000Z', 30, {now}), false);
  assert.equal(inContentWindow(new Date(now - 29 * 86_400_000).toISOString(), 30, {now}), true);
  const dayLabel = parseBilibiliDate('9月17日', now);
  assert.equal(inContentWindow(dayLabel, 30, {now}), false);
  assert.equal(inContentWindow(dayLabel, 30, {now, dayPrecision: true}), true);
  assert.equal(inContentWindow(parseBilibiliDate('9月16日', now), 30, {now, dayPrecision: true}), false);
});
