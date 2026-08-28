import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import express, {NextFunction, Request, Response} from 'express';
import {AppConfig} from '../config';
import {normalizeResearchRequest, RequestValidationError} from '../domain/validation';
import {buildReportData} from '../processing/reporter';
import {CHROME_REMOTE_DEBUGGING_URL, openChromeRemoteDebugging} from '../services/chromeSettings';
import {chooseDataDirectory} from '../services/dataDirectoryPicker';
import {saveDataRoot} from '../services/dataRootSettings';
import {RESEARCH_API_VERSION, RESEARCH_APP_ID} from '../services/existingInstance';
import {RunManager} from '../services/runManager';

const asyncRoute = (
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
) => (request: Request, response: Response, next: NextFunction) => {
  void handler(request, response, next).catch(next);
};

const mutationOriginGuard = (config: AppConfig) => (request: Request, response: Response, next: NextFunction) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next();
  const origin = request.get('origin');
  const allowed = new Set([
    `http://${config.host}:${config.port}`,
    'http://127.0.0.1:5173'
  ]);
  if (origin && !allowed.has(origin)) {
    response.status(403).json({message: '只允许本机调查界面执行此操作。'});
    return;
  }
  next();
};

/** Creates the loopback-only API and serves the compiled beginner UI. */
interface AppDependencies {
  chooseDataDirectory: typeof chooseDataDirectory;
  saveDataRoot: typeof saveDataRoot;
  webRoot: string;
}

export const createApp = (
  manager: RunManager,
  config: AppConfig,
  dependencies: Partial<AppDependencies> = {}
) => {
  const openDataDirectoryPicker = dependencies.chooseDataDirectory ?? chooseDataDirectory;
  const persistDataRoot = dependencies.saveDataRoot ?? saveDataRoot;
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
  });
  app.use(express.json({limit: '128kb'}));
  app.use(mutationOriginGuard(config));

  app.get('/api/health', (_request, response) => response.json({
    ok: true,
    app: RESEARCH_APP_ID,
    apiVersion: RESEARCH_API_VERSION
  }));
  app.get('/api/settings', (_request, response) => response.json({
    apiVersion: RESEARCH_API_VERSION,
    dataRoot: config.dataRoot,
    dataRootLocked: Boolean(process.env.RESEARCH_DATA_DIR?.trim()),
    analysis: {
      aiConfigured: Boolean(config.openAiApiKey),
      model: config.aiModel,
      reasoningEffort: config.aiReasoningEffort,
      liveMode: 'ai',
      demoMode: 'rule_demo'
    },
    defaults: {
      durationMinutes: 5,
      contentWindowDays: 30,
      keywords: ['火影忍者手游', '火影手游决斗场', '火影手游高招'],
      includeVideos: true,
      includeDynamics: true,
      mode: 'live',
      browserVisible: true,
      browserWindowCount: 1,
      maxSources: 20
    }
  }));
  app.post('/api/settings/select-data-root', asyncRoute(async (_request, response) => {
    if (process.env.RESEARCH_DATA_DIR?.trim()) {
      response.status(409).json({message: '存放位置当前由 RESEARCH_DATA_DIR 固定，请先移除该环境配置并重新启动。'});
      return;
    }
    const previousDataRoot = config.dataRoot;
    const selected = await openDataDirectoryPicker(previousDataRoot);
    if (!selected) {
      response.json({dataRoot: previousDataRoot, cancelled: true});
      return;
    }

    const dataRoot = await manager.changeDataRoot(selected);
    try {
      await persistDataRoot(dataRoot);
    } catch (error) {
      await manager.changeDataRoot(previousDataRoot);
      throw error;
    }
    response.json({dataRoot, previousDataRoot, cancelled: false});
  }));
  app.get('/api/runs', asyncRoute(async (_request, response) => {
    response.json({runs: await manager.list()});
  }));
  app.post('/api/runs', asyncRoute(async (request, response) => {
    const normalized = normalizeResearchRequest(request.body);
    if (normalized.mode === 'live' && !config.openAiApiKey) {
      response.status(409).json({message: '真实调查需要先配置 OPENAI_API_KEY；演示模式仍可使用本地规则。'});
      return;
    }
    const manifest = await manager.start(normalized);
    response.status(201).json({run: manifest});
  }));
  app.get('/api/runs/:runId', asyncRoute(async (request, response) => {
    response.json({
      run: await manager.get(request.params.runId),
      events: await manager.store.readEvents(request.params.runId, 80)
    });
  }));
  app.get('/api/runs/:runId/records', asyncRoute(async (request, response) => {
    const runId = request.params.runId;
    await manager.get(runId);
    const kind = request.query.kind === 'contents' ? 'contents'
      : request.query.kind === undefined || request.query.kind === 'opinions' ? 'opinions' : null;
    const offset = Number(request.query.offset ?? 0);
    const limit = Number(request.query.limit ?? 50);
    if (!kind || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      const error = new Error('记录浏览参数不正确。') as Error & {statusCode: number};
      error.statusCode = 400;
      throw error;
    }
    const query = String(request.query.q ?? '').trim().toLocaleLowerCase('zh-CN');
    const includesQuery = (...values: Array<unknown>) => !query || values.some((value) => (
      value !== undefined && value !== null && String(value).toLocaleLowerCase('zh-CN').includes(query)
    ));

    if (kind === 'contents') {
      const contents = (await manager.store.readContents(runId)).filter((content) => includesQuery(
        content.id,
        content.title,
        content.description,
        content.discoveryKeyword,
        content.url,
        content.resolvedUrl
      ));
      response.json({kind, total: contents.length, offset, limit, records: contents.slice(offset, offset + limit)});
      return;
    }

    const [contents, opinions] = await Promise.all([
      manager.store.readContents(runId),
      manager.store.readOpinions(runId)
    ]);
    const contentById = new Map(contents.map((content) => [content.id, content]));
    const matching = opinions.filter((opinion) => {
      const content = contentById.get(opinion.contentId);
      return includesQuery(
        opinion.id,
        opinion.text,
        opinion.authorName,
        opinion.authorUid,
        opinion.sourceRecordId,
        opinion.parentSourceRecordId,
        opinion.sourceUrl,
        opinion.contentId,
        content?.title
      );
    });
    response.json({
      kind,
      total: matching.length,
      offset,
      limit,
      records: matching.slice(offset, offset + limit).map((record) => ({
        record,
        contentTitle: contentById.get(record.contentId)?.title
      }))
    });
  }));
  app.post('/api/runs/:runId/pause', asyncRoute(async (request, response) => {
    response.json({run: await manager.pause(request.params.runId)});
  }));
  app.post('/api/runs/:runId/resume', asyncRoute(async (request, response) => {
    response.json({run: await manager.resume(request.params.runId)});
  }));
  app.post('/api/runs/:runId/finalize', asyncRoute(async (request, response) => {
    response.json({run: await manager.finalize(request.params.runId)});
  }));
  app.post('/api/runs/:runId/reanalyze', asyncRoute(async (request, response) => {
    response.json({run: await manager.reanalyze(request.params.runId)});
  }));
  app.post('/api/runs/:runId/extend', asyncRoute(async (request, response) => {
    response.json({run: await manager.extend(request.params.runId, Number(request.body?.minutes))});
  }));
  app.post('/api/runs/:runId/open-folder', asyncRoute(async (request, response) => {
    const directory = manager.store.runDirectory(request.params.runId);
    if (process.platform === 'win32') {
      const child = spawn('explorer.exe', [directory], {detached: true, stdio: 'ignore'});
      child.unref();
    } else {
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, [directory], {detached: true, stdio: 'ignore'});
      child.unref();
    }
    response.json({ok: true});
  }));
  app.post('/api/chrome/open-remote-debugging', asyncRoute(async (_request, response) => {
    await openChromeRemoteDebugging();
    response.json({ok: true, url: CHROME_REMOTE_DEBUGGING_URL});
  }));
  app.get('/api/chrome/status', asyncRoute(async (_request, response) => {
    response.json({chrome: await manager.chromeConnection.status()});
  }));
  app.post('/api/chrome/connect', asyncRoute(async (_request, response) => {
    response.json({chrome: await manager.chromeConnection.connect()});
  }));
  app.post('/api/chrome/disconnect', asyncRoute(async (_request, response) => {
    response.json({chrome: await manager.chromeConnection.disconnect()});
  }));
  app.get('/api/runs/:runId/report', asyncRoute(async (request, response) => {
    const manifest = await manager.get(request.params.runId);
    if (!manifest.reportReady) {
      response.status(409).json({message: '报告还没有生成完成。'});
      return;
    }
    response.type('text/markdown; charset=utf-8').send(await manager.store.readReport(request.params.runId));
  }));
  app.get('/api/runs/:runId/report-data', asyncRoute(async (request, response) => {
    const runId = request.params.runId;
    const manifest = await manager.get(runId);
    if (!manifest.reportReady) {
      response.status(409).json({message: '报告还没有生成完成。'});
      return;
    }
    const [contents, opinions, classifications, quality] = await Promise.all([
      manager.store.readContents(runId),
      manager.store.readProcessedOpinions(runId),
      manager.store.readClassifications(runId),
      manager.store.readQualityReport(runId)
    ]);
    response.json({report: buildReportData(manifest, contents, opinions, classifications, quality)});
  }));
  app.get('/api/runs/:runId/events', asyncRoute(async (request, response) => {
    const runId = request.params.runId;
    await manager.get(runId);
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    response.flushHeaders();
    const send = (manifest: Awaited<ReturnType<RunManager['get']>>) => {
      if (manifest.id === runId && !response.destroyed && !response.writableEnded) {
        response.write(`data: ${JSON.stringify(manifest)}\n\n`);
      }
    };
    send(await manager.get(runId));
    const unsubscribe = manager.subscribe(send);
    const liveSnapshot = setInterval(() => {
      void manager.get(runId).then(send).catch(() => undefined);
    }, 1_000);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    request.on('close', () => {
      clearInterval(liveSnapshot);
      clearInterval(heartbeat);
      unsubscribe();
    });
  }));

  const webRoot = dependencies.webRoot ?? join(process.cwd(), 'web', 'dist');
  if (existsSync(webRoot)) {
    app.use(express.static(webRoot, {index: false, maxAge: '1h'}));
    app.get('*', (_request, response) => response.sendFile(join(webRoot, 'index.html')));
  } else {
    app.get('/', (_request, response) => response.status(503).type('text/plain').send(
      '网页版尚未构建。请先运行 npm run build，开发模式可运行 npm run dev:web。'
    ));
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = error instanceof RequestValidationError ? error.statusCode
      : (error as {statusCode?: number})?.statusCode ?? 500;
    const message = error instanceof Error ? error.message : '发生未知错误。';
    response.status(status).json({message});
  });
  return app;
};
