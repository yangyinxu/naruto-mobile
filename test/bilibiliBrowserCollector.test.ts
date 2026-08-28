import assert from 'node:assert/strict';
import test from 'node:test';
import {Page} from 'playwright';
import {AppConfig} from '../src/config';
import {BilibiliBrowserCollector} from '../src/collectors/bilibiliBrowserCollector';
import {CollectionContext} from '../src/domain/types';
import {ChromeConnectionService} from '../src/services/chromeConnection';

const config: AppConfig = {
  host: '127.0.0.1',
  port: 3765,
  dataRoot: 'data',
  browserChannel: 'chrome',
  browserHeadless: false,
  openBrowser: false,
  uidSalt: 'test-salt',
  aiModel: 'gpt-5.6-luna',
  aiReasoningEffort: 'medium',
  aiBatchSize: 10,
  aiConcurrency: 3
};

test('initializes and closes the worker page pool without a temporal dead zone error', async () => {
  let released = false;
  let closed = false;
  const page = {
    setDefaultTimeout: () => undefined,
    close: async () => {
      closed = true;
    }
  } as unknown as Page;
  const chromeConnection = {
    acquire: async () => ({
      context: {newPage: async () => page},
      release: () => {
        released = true;
      }
    })
  } as unknown as ChromeConnectionService;
  const context: CollectionContext = {
    manifest: {
      schemaVersion: 1,
      id: 'run-1',
      state: 'pause_requested',
      request: {
        name: 'test',
        durationMinutes: 3,
        contentWindowDays: 7,
        keywords: ['火影忍者手游'],
        includeVideos: true,
        includeDynamics: false,
        mode: 'live',
        browserVisible: true,
        browserWindowCount: 1,
        maxSources: 10
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeElapsedMs: 0,
      statusMessage: 'pause requested',
      counts: {candidates: 1, contents: 0, opinions: 0, validOpinions: 0, sources: 0, warnings: 0},
      reportReady: false
    },
    checkpoint: {
      schemaVersion: 1,
      pendingCandidates: [{
        id: 'BV1test',
        type: 'video',
        url: 'https://www.bilibili.com/video/BV1test',
        title: 'test',
        discoveryKeyword: '火影忍者手游',
        discoveryRank: 1
      }],
      seenContentIds: [],
      seenOpinionIds: [],
      activeElapsedMs: 0,
      updatedAt: new Date().toISOString()
    },
    callbacks: {
      getDirective: () => 'pause',
      remainingMs: () => 180_000,
      onState: async () => undefined,
      onCandidates: async () => undefined,
      onContent: async () => undefined,
      onOpinion: async () => undefined,
      onCheckpoint: async () => undefined,
      onWarning: async () => undefined
    }
  };

  const result = await new BilibiliBrowserCollector(config, chromeConnection).collect(context);

  assert.equal(result.outcome, 'paused');
  assert.equal(closed, true);
  assert.equal(released, true);
});
