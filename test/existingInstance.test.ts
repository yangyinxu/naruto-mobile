import assert from 'node:assert/strict';
import test from 'node:test';
import {isResearchToolRunning, RESEARCH_APP_ID} from '../src/services/existingInstance';

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {'content-type': 'application/json'}
});

test('recognizes a running research tool by its app identifier', async () => {
  const fetchStub = (async () => jsonResponse({ok: true, app: RESEARCH_APP_ID, apiVersion: 1})) as typeof fetch;
  assert.equal(await isResearchToolRunning('http://127.0.0.1:3765', fetchStub), true);
});

test('recognizes an older running build from its settings contract', async () => {
  const fetchStub = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/health')) return jsonResponse({ok: true});
    return jsonResponse({
      dataRoot: 'D:/research-data',
      defaults: {keywords: ['火影忍者手游']}
    });
  }) as typeof fetch;
  assert.equal(await isResearchToolRunning('http://127.0.0.1:3765/', fetchStub), true);
});

test('does not treat another service on the same port as this tool', async () => {
  const fetchStub = (async () => jsonResponse({ok: true, app: 'different-local-app'})) as typeof fetch;
  assert.equal(await isResearchToolRunning('http://127.0.0.1:3765', fetchStub), false);
});
