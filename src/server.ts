import open from 'open';
import {createApp} from './api/app';
import {loadAppConfig} from './config';
import {FileRunStore} from './infrastructure/fileRunStore';
import {isResearchToolRunning} from './services/existingInstance';
import {RunManager} from './services/runManager';

const config = loadAppConfig();
const store = new FileRunStore(config.dataRoot);
const manager = new RunManager(store, config);
await manager.initialize();

const app = createApp(manager, config);
const url = `http://${config.host}:${config.port}`;
const server = app.listen(config.port, config.host, async () => {
  console.log(`火影手游玩家反馈调查工具已启动：${url}`);
  console.log(`本地数据目录：${config.dataRoot}`);
  if (config.openBrowser) await open(url).catch(() => undefined);
});

server.once('error', async (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE' && await isResearchToolRunning(url)) {
    console.log(`工具已经在运行，正在打开现有页面：${url}`);
    if (config.openBrowser) await open(url).catch(() => undefined);
    process.exit(0);
  }

  if (error.code === 'EADDRINUSE') {
    console.error(`无法启动：本机端口 ${config.port} 正被其他程序使用。请关闭占用程序或在 .env 中修改 PORT。`);
  } else {
    console.error(`无法启动本地工具：${error.message}`);
  }
  process.exit(1);
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`收到 ${signal}，现有检查点会在下次启动时恢复。`);
  server.close(() => {
    void manager.chromeConnection.disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5_000).unref();
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
