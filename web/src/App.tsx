import {useCallback, useEffect, useState} from 'react';
import {Archive, BookOpen, Flame, Palette, PlusCircle, X} from 'lucide-react';
import {ChromeGuide} from './components/ChromeGuide';
import {History} from './components/History';
import {NewResearch} from './components/NewResearch';
import {RecordsView} from './components/RecordsView';
import {ReportView} from './components/ReportView';
import {RunDetail} from './components/RunDetail';
import {api} from './lib/api';
import {AppSettings, ChromeConnectionStatus, ResearchRequest, RunManifest} from './types';

type View = 'new' | 'guide' | 'history' | 'run' | 'report' | 'records';
type Skin = 'classic' | 'shinobi';

const SKIN_STORAGE_KEY = 'naruto-research-skin';

const initialSkin = (): Skin => {
  const forced = new URLSearchParams(window.location.search).get('skin');
  if (forced === 'classic' || forced === 'shinobi') return forced;
  const saved = window.localStorage.getItem(SKIN_STORAGE_KEY);
  return saved === 'shinobi' ? 'shinobi' : 'classic';
};

export default function App() {
  const [settings, setSettings] = useState<AppSettings>();
  const [runs, setRuns] = useState<RunManifest[]>([]);
  const [view, setView] = useState<View>('new');
  const [selected, setSelected] = useState<RunManifest>();
  const [busy, setBusy] = useState(false);
  const [selectingDataRoot, setSelectingDataRoot] = useState(false);
  const [chromeStatus, setChromeStatus] = useState<ChromeConnectionStatus>();
  const [connectingChrome, setConnectingChrome] = useState(false);
  const [error, setError] = useState('');
  const [skin, setSkin] = useState<Skin>(initialSkin);

  const loadRuns = useCallback(() => api.listRuns().then(setRuns).catch((reason) => setError(reason.message)), []);
  useEffect(() => {
    void api.settings().then(setSettings).catch((reason) => setError(reason.message));
    void loadRuns();
  }, [loadRuns]);
  useEffect(() => {
    let active = true;
    const refresh = () => api.chromeStatus()
      .then((status) => { if (active) setChromeStatus(status); })
      .catch((reason) => { if (active) setError(reason.message); });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    window.scrollTo({top: 0, left: 0, behavior: 'auto'});
  }, [view]);
  useEffect(() => {
    window.localStorage.setItem(SKIN_STORAGE_KEY, skin);
    document.documentElement.dataset.skin = skin;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute('content', skin === 'shinobi' ? '#010814' : '#15130f');
  }, [skin]);

  const start = async (request: ResearchRequest) => {
    setBusy(true);
    setError('');
    try {
      const run = await api.startRun(request);
      setSelected(run);
      setView('run');
      await loadRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const openRun = (run: RunManifest) => {
    setSelected(run);
    setView(run.reportReady ? 'report' : 'run');
  };

  const browseRecords = (run: RunManifest) => {
    if ((settings?.apiVersion ?? 0) < 7) {
      setError('后台仍在运行旧版本。请关闭当前工具后重新双击启动，再浏览完整记录。');
      return;
    }
    setSelected(run);
    setView('records');
  };

  const openRunFolder = (run: RunManifest) => {
    void api.openFolder(run.id).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const openChromeSettings = async () => {
    setError('');
    try {
      await api.openChromeSettings();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  };

  const connectChrome = async () => {
    if (chromeStatus?.state === 'disconnecting') return;
    if (!chromeStatus?.remoteDebuggingEnabled) {
      setView('guide');
      await openChromeSettings();
      return;
    }
    setConnectingChrome(true);
    setError('');
    try {
      setChromeStatus((current) => current ? {...current, state: 'connecting', message: '正在请求连接，请在 Chrome 弹窗中点击“允许”。'} : current);
      setChromeStatus(await api.connectChrome());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setChromeStatus(await api.chromeStatus().catch(() => chromeStatus));
    } finally {
      setConnectingChrome(false);
    }
  };

  const disconnectChrome = async () => {
    setError('');
    try {
      setChromeStatus((current) => current ? {
        ...current,
        state: 'disconnecting',
        message: '正在安全断开 Chrome，请稍候。'
      } : current);
      setChromeStatus(await api.disconnectChrome());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setChromeStatus(await api.chromeStatus().catch(() => chromeStatus));
    }
  };

  const selectDataRoot = async () => {
    setSelectingDataRoot(true);
    setError('');
    try {
      const result = await api.selectDataRoot();
      if (result.cancelled) return;
      setSettings((current) => current ? {...current, dataRoot: result.dataRoot} : current);
      setSelected(undefined);
      setView('new');
      await loadRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSelectingDataRoot(false);
    }
  };

  if (!settings) return <div className="app-loading"><Flame className="brand-flame"/><strong>正在启动本地调查工具…</strong></div>;

  return (
    <div className={`app-shell skin-${skin}`} data-skin={skin}>
      <header className="topbar">
        <button className="brand" onClick={() => setView('new')}><span><Flame/></span><div><strong>火影手游</strong><small>玩家反馈调查工具</small></div></button>
        <nav>
          <button className={view === 'new' ? 'active' : ''} onClick={() => setView('new')}><PlusCircle/>新建调查</button>
          <button className={`guide-nav ${view === 'guide' ? 'active' : ''}`} onClick={() => setView('guide')}><BookOpen/><span className="guide-nav-label"><b>Chrome </b>教程</span><span className="guide-nav-badge">首次必看</span></button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => {void loadRuns(); setView('history');}}><Archive/>历史调查{runs.length > 0 && <i>{runs.length}</i>}</button>
        </nav>
        <div className="topbar-tools">
          <label className="skin-picker">
            <Palette aria-hidden="true"/>
            <span>皮肤</span>
            <select aria-label="界面皮肤" value={skin} onChange={(event) => setSkin(event.target.value as Skin)}>
              <option value="classic">经典</option>
              <option value="shinobi">忍者密卷</option>
            </select>
          </label>
          <div className="local-pill"><span/>本地运行</div>
        </div>
      </header>

      {view === 'new' && (
        <NewResearch settings={settings} chromeStatus={chromeStatus} connectingChrome={connectingChrome} busy={busy} selectingDataRoot={selectingDataRoot} onStart={start} onSelectDataRoot={selectDataRoot} onOpenGuide={() => setView('guide')} onConnectChrome={connectChrome} onDisconnectChrome={disconnectChrome}/>
      )}
      {view === 'guide' && (
        <ChromeGuide chromeSettingsSupported={(settings.apiVersion ?? 0) >= 6} chromeStatus={chromeStatus} connectingChrome={connectingChrome} onBack={() => setView('new')} onOpenChromeSettings={openChromeSettings} onConnectChrome={connectChrome} onDisconnectChrome={disconnectChrome}/>
      )}
      {view === 'history' && (
        <History runs={runs} onOpen={openRun} onBrowse={browseRecords} onOpenFolder={openRunFolder}/>
      )}
      {view === 'run' && selected && (
        <RunDetail initial={selected} onBack={() => {void loadRuns(); setView('history');}} onReport={(run) => {setSelected(run); setView('report');}} onError={setError}/>
      )}
      {view === 'report' && selected && (
        <ReportView run={selected} onBack={() => setView('run')} onError={setError}/>
      )}
      {view === 'records' && selected && (
        <RecordsView run={selected} onBack={() => {void loadRuns(); setView('history');}} onError={setError}/>
      )}

      {error && <div className="toast" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><X/></button></div>}
    </div>
  );
}
