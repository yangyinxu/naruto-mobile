import assert from 'node:assert/strict';
import test from 'node:test';
import {CHROME_REMOTE_DEBUGGING_URL, openChromeRemoteDebugging} from '../src/services/chromeSettings';

test('opens the protected Chrome connection page in Google Chrome', async () => {
  const calls: Array<{target: string; options: {app: {name: string | readonly string[]; arguments: readonly string[]}; wait: boolean}}> = [];
  await openChromeRemoteDebugging(async (target, options) => {
    calls.push({target, options});
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, CHROME_REMOTE_DEBUGGING_URL);
  assert.equal(calls[0].options.app.name, 'chrome');
  assert.deepEqual(calls[0].options.app.arguments, ['--new-window']);
  assert.equal(calls[0].options.wait, false);
});
