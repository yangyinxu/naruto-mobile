import {createServer as createNetServer} from 'node:net';
import {join} from 'node:path';
import type {Server} from 'node:http';
import {app as electronApp, BrowserWindow, dialog, shell} from 'electron';
import {createApp} from './api/app';
import {loadAppConfig} from './config';
import {FileRunStore} from './infrastructure/fileRunStore';
import {isResearchToolRunning} from './services/existingInstance';
import {RunManager} from './services/runManager';

let mainWindow: BrowserWindow | null = null;
let httpServer: Server | null = null;
let manager: RunManager | null = null;
let shuttingDown = false;

const findAvailablePort = (preferredPort: number) => new Promise<number>((resolve, reject) => {
  const probe = createNetServer();
  probe.unref();
  probe.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') {
      reject(error);
      return;
    }
    const fallback = createNetServer();
    fallback.unref();
    fallback.once('error', reject);
    fallback.listen(0, '127.0.0.1', () => {
      const address = fallback.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      fallback.close(() => resolve(port));
    });
  });
  probe.listen(preferredPort, '127.0.0.1', () => probe.close(() => resolve(preferredPort)));
});

const listen = (port: number, host: string) => new Promise<Server>((resolve, reject) => {
  if (!manager) {
    reject(new Error('调查管理器尚未初始化。'));
    return;
  }
  const resourceRoot = process.env.RESEARCH_RESOURCE_ROOT ?? process.cwd();
  const server = createApp(manager, managerConfig, {
    webRoot: join(resourceRoot, 'web')
  }).listen(port, host);
  server.once('listening', () => resolve(server));
  server.once('error', reject);
});

let managerConfig: ReturnType<typeof loadAppConfig>;

const openMainWindow = async (url: string) => {
  if (process.env.NARUTO_DESKTOP_HEADLESS === 'true') return;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#f4f1ea',
    title: '火影手游玩家反馈调查工具',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({url: externalUrl}) => {
    if (/^https?:\/\//i.test(externalUrl)) void shell.openExternal(externalUrl);
    return {action: 'deny'};
  });
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    if (destination !== url && !destination.startsWith(`${url}/`)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(destination)) void shell.openExternal(destination);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(url);
};

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager?.chromeConnection.disconnect().catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }
    httpServer.close(() => resolve());
  });
  electronApp.exit(0);
};

const start = async () => {
  const resourceRoot = electronApp.isPackaged
    ? join(process.resourcesPath, 'app')
    : process.cwd();
  process.env.RESEARCH_RESOURCE_ROOT = resourceRoot;
  process.env.RESEARCH_DEFAULT_DATA_DIR ??= join(electronApp.getPath('userData'), 'data');
  process.env.NO_OPEN = 'true';

  managerConfig = loadAppConfig();
  const preferredUrl = `http://${managerConfig.host}:${managerConfig.port}`;
  if (await isResearchToolRunning(preferredUrl)) {
    await openMainWindow(preferredUrl);
    return;
  }

  managerConfig.port = await findAvailablePort(managerConfig.port);
  managerConfig.openBrowser = false;
  manager = new RunManager(new FileRunStore(managerConfig.dataRoot), managerConfig);
  await manager.initialize();
  httpServer = await listen(managerConfig.port, managerConfig.host);

  const url = `http://${managerConfig.host}:${managerConfig.port}`;
  await openMainWindow(url);
};

electronApp.setName('火影手游玩家反馈调查工具');
const hasSingleInstanceLock = electronApp.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  electronApp.quit();
} else {
  electronApp.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  electronApp.on('window-all-closed', () => electronApp.quit());
  electronApp.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown();
  });
  electronApp.whenReady().then(start).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('启动失败', `火影手游玩家反馈调查工具无法启动：\n\n${message}`);
    electronApp.exit(1);
  });
}
