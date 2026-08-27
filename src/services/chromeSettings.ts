import open, {apps} from 'open';

export const CHROME_REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging';

type ChromeLauncher = (
  target: string,
  options: {app: {name: string | readonly string[]; arguments: readonly string[]}; wait: boolean}
) => Promise<unknown>;

/** Opens Chrome's own connection settings without attempting to change protected browser settings. */
export const openChromeRemoteDebugging = async (
  launcher: ChromeLauncher = open as ChromeLauncher
) => {
  try {
    await launcher(CHROME_REMOTE_DEBUGGING_URL, {
      app: {name: apps.chrome, arguments: ['--new-window']},
      wait: false
    });
  } catch {
    throw new Error('无法打开 Chrome 连接设置。请确认已经安装 Google Chrome。');
  }
};
