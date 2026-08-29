import {FormEvent, useMemo, useState} from 'react';
import {ArrowRight, BookOpen, Check, CircleAlert, CircleCheck, Clock3, Files, FlaskConical, FolderOpen, Gauge, KeyRound, LoaderCircle, LogOut, MonitorCog, Search, Sparkles, Unplug} from 'lucide-react';
import {AppSettings, ChromeConnectionStatus, ResearchRequest} from '../types';

interface Props {
  settings: AppSettings;
  chromeStatus?: ChromeConnectionStatus;
  connectingChrome: boolean;
  busy: boolean;
  selectingDataRoot: boolean;
  onStart: (request: ResearchRequest) => Promise<void>;
  onSelectDataRoot: () => Promise<void>;
  onLoginAnalysis?: (identifier: string, password: string) => Promise<void>;
  onLogoutAnalysis?: () => Promise<void>;
  onOpenGuide: () => void;
  onConnectChrome: () => Promise<void>;
  onDisconnectChrome: () => Promise<void>;
}

const presets = [
  {minutes: 5, title: '快速体验', description: '先看热点，适合第一次使用'},
  {minutes: 30, title: '标准调查', description: '覆盖更多视频和评论'},
  {minutes: 120, title: '深入调查', description: '适合版本或活动复盘'}
];

export const NewResearch = ({
  settings,
  chromeStatus,
  connectingChrome,
  busy,
  selectingDataRoot,
  onStart,
  onSelectDataRoot,
  onLoginAnalysis,
  onLogoutAnalysis,
  onOpenGuide,
  onConnectChrome,
  onDisconnectChrome
}: Props) => {
  const [durationMinutes, setDuration] = useState(settings.defaults.durationMinutes);
  const [contentWindowDays, setWindow] = useState(settings.defaults.contentWindowDays);
  const [keywords, setKeywords] = useState(settings.defaults.keywords.join('\n'));
  const [includeVideos, setVideos] = useState(settings.defaults.includeVideos);
  const [includeDynamics, setDynamics] = useState(settings.defaults.includeDynamics);
  const [mode, setMode] = useState<'live' | 'demo'>(settings.defaults.mode);
  const [browserWindowCount, setBrowserWindowCount] = useState(settings.defaults.browserWindowCount);
  const [maxSources, setMaxSources] = useState(settings.defaults.maxSources);
  const [archtreeIdentifier, setArchtreeIdentifier] = useState('');
  const [archtreePassword, setArchtreePassword] = useState('');
  const [authenticating, setAuthenticating] = useState(false);
  const [authenticationError, setAuthenticationError] = useState('');
  const keywordList = useMemo(() => keywords.split(/\r?\n|，|,/).map((item) => item.trim()).filter(Boolean), [keywords]);
  const chromeTransitioning = connectingChrome
    || chromeStatus?.state === 'connecting'
    || chromeStatus?.state === 'disconnecting';
  const chromeReady = chromeStatus?.state === 'connected'
    && chromeStatus.connected
    && chromeStatus.loginState === 'logged_in';
  const chromeActionLabel = !chromeStatus?.remoteDebuggingEnabled
    ? '开启并连接 Chrome'
    : chromeStatus.connected && chromeStatus.loginState !== 'logged_in'
      ? '重新检查 B站登录'
      : chromeStatus.connected ? '重新检查连接' : '连接并检查 B站';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onStart({
      name: `火影手游玩家反馈调查 · ${new Date().toLocaleDateString('zh-CN')}`,
      durationMinutes,
      contentWindowDays,
      keywords: keywordList,
      includeVideos,
      includeDynamics,
      mode,
      browserVisible: true,
      browserWindowCount: mode === 'live' ? browserWindowCount : 1,
      maxSources
    });
  };

  const loginAnalysis = async () => {
    setAuthenticating(true);
    setAuthenticationError('');
    try {
      if (!onLoginAnalysis) throw new Error('当前版本不支持 Archtree 登录。');
      await onLoginAnalysis(archtreeIdentifier, archtreePassword);
      setArchtreePassword('');
    } catch (error) {
      setAuthenticationError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthenticating(false);
    }
  };

  const logoutAnalysis = async () => {
    setAuthenticating(true);
    setAuthenticationError('');
    try {
      if (!onLogoutAnalysis) throw new Error('当前版本不支持退出 Archtree。');
      await onLogoutAnalysis();
    } catch (error) {
      setAuthenticationError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthenticating(false);
    }
  };

  return (
    <main className="new-research page-grid">
      <section className="hero-copy">
        <div className="eyebrow"><Sparkles size={15}/> 原始数据本地保存 · Luna AI 筛选</div>
        <h1>把社区声音，整理成<br/><em>可行动的产品情报</em></h1>
        <p>真实调查会完整保存公开意见，再由 Luna 筛选强洞察；演示模式继续使用本地规则。</p>
        <div className="privacy-note">
          <Check size={18}/>
          <div className="privacy-note-content">
            <span>原始采集数据写入你的电脑：<strong>{settings.dataRoot}</strong></span>
            <button className="data-location-button" type="button" disabled={selectingDataRoot || settings.dataRootLocked} onClick={() => void onSelectDataRoot()}>
              <FolderOpen size={16}/>{selectingDataRoot ? '正在选择…' : settings.dataRootLocked ? '位置由环境配置固定' : '选择存放位置'}
            </button>
            <small>真实模式会把不含用户名、UID和主页的评论语境经由私人服务器发送给 OpenAI；更改位置不会移动原文件。</small>
          </div>
        </div>
      </section>

      <form className="setup-card" onSubmit={submit}>
        <ol className="shinobi-mission-score" aria-hidden="true">
          <li className="complete"><span>1</span><strong>设定时长</strong><small>最长 {durationMinutes} 分钟</small></li>
          <li className="current"><span>2</span><strong>情报范围</strong><small>{keywordList.length} 个关键词 · {contentWindowDays} 天</small></li>
          <li><span>3</span><strong>调查方式</strong><small>{mode === 'live' ? `真实调查 · ${browserWindowCount} 标签页` : '演示模式'}</small></li>
          <li><span>4</span><strong>确认任务</strong><small>最多 {maxSources} 个来源</small></li>
        </ol>
        <div className="step-heading"><span>1</span><div><h2>最长采集多久？</h2><p>达到时长或来源上限时结束，暂停时间不计入</p></div></div>
        <div className="preset-grid">
          {presets.map((preset) => (
            <button
              className={`preset ${durationMinutes === preset.minutes ? 'selected' : ''}`}
              type="button"
              key={preset.minutes}
              onClick={() => setDuration(preset.minutes)}
            >
              <Clock3 size={19}/><strong>{preset.minutes < 60 ? `${preset.minutes} 分钟` : `${preset.minutes / 60} 小时`}</strong>
              <span>{preset.title}</span><small>{preset.description}</small>
            </button>
          ))}
        </div>
        <label className="custom-duration">
          <span><strong>最长采集时长（分钟）</strong><small>可设置 1–720 分钟；来源先采完时会提前结束</small></span>
          <div><input aria-label="最长采集时长（分钟）" type="number" min={1} max={720} value={durationMinutes} onChange={(event) => setDuration(Number(event.target.value))}/><em>分钟</em></div>
        </label>

        <div className="form-divider"/>
        <div className="step-heading"><span>2</span><div><h2>调查哪些内容？</h2><p>默认设置可以直接开始</p></div></div>
        <label className="field-label" htmlFor="keywords">关键词 <small>每行一个</small></label>
        <div className="input-with-icon"><Search size={18}/><textarea id="keywords" value={keywords} onChange={(event) => setKeywords(event.target.value)} rows={3}/></div>
        <div className="inline-options">
          <label className="check-option"><input type="checkbox" checked={includeVideos} onChange={(event) => setVideos(event.target.checked)}/><span>热门视频</span></label>
          <label className="check-option"><input type="checkbox" checked={includeDynamics} onChange={(event) => setDynamics(event.target.checked)}/><span>热门动态</span></label>
          <label className="select-option"><span>内容范围</span><select value={contentWindowDays} onChange={(event) => setWindow(Number(event.target.value))}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option></select></label>
        </div>

        <div className="advanced-heading">
          <strong>高级选项</strong>
          <small>选择调查运行模式</small>
        </div>
        <div className="advanced-panel">
          <label className={`mode-card ${mode === 'live' ? 'selected' : ''}`}><input type="radio" checked={mode === 'live'} onChange={() => setMode('live')}/><Search size={20}/><span><strong>真实调查 · Luna AI</strong><small>{settings.analysis?.aiConfigured ? `${settings.analysis.model} 已就绪` : settings.analysis?.transport === 'direct' ? '需要配置 OpenAI API 密钥' : '需要登录 Archtree'}</small></span></label>
          <label className={`mode-card ${mode === 'demo' ? 'selected' : ''}`}><input type="radio" checked={mode === 'demo'} onChange={() => setMode('demo')}/><FlaskConical size={20}/><span><strong>本地演示</strong><small>虚构样本与本地规则，不调用 AI</small></span></label>
        </div>
        <label className={`parallel-windows ${mode === 'demo' ? 'disabled' : ''}`}>
          <span className="parallel-windows-icon"><Gauge size={20}/></span>
          <span className="parallel-windows-copy">
            <strong>并行调查标签页</strong>
            <small>{mode === 'live' ? '在已连接的 Chrome 中同时读取多个来源；建议先用 2 个。' : '演示模式不打开 Chrome 标签页。'}</small>
          </span>
          <select
            aria-label="并行调查标签页数"
            value={mode === 'live' ? browserWindowCount : 1}
            disabled={mode === 'demo'}
            onChange={(event) => setBrowserWindowCount(Number(event.target.value))}
          >
            <option value={1}>1 个 · 稳妥</option>
            <option value={2}>2 个 · 推荐</option>
            <option value={3}>3 个 · 较快</option>
            <option value={4}>4 个 · 最快</option>
          </select>
        </label>
        <label className="parallel-windows source-limit">
          <span className="parallel-windows-icon"><Files size={20}/></span>
          <span className="parallel-windows-copy">
            <strong>最多采集来源数</strong>
            <small>视频和动态合计，可设置 3–200 个；采完这个数量会生成报告。</small>
          </span>
          <div className="source-limit-input"><input aria-label="最多采集来源数" type="number" min={3} max={200} value={maxSources} onChange={(event) => setMaxSources(Number(event.target.value))}/><em>个</em></div>
        </label>
        <p className="stop-rule-note"><CircleAlert size={16}/> 本次调查将在“达到 {durationMinutes} 分钟”或“处理完 {maxSources} 个来源”时结束，以先发生者为准。</p>

        {settings.analysis?.transport === 'proxy' && settings.analysis.loginRequired && (
          <section className="analysis-activation-card" aria-labelledby="analysis-activation-title">
            <span className="analysis-activation-icon"><KeyRound size={22}/></span>
            <div className="analysis-activation-copy">
              <strong id="analysis-activation-title">登录 Archtree 后使用 AI 分析</strong>
              <small>使用任意普通 Archtree 账号即可。密码不会保存，OpenAI 密钥也不会进入这台电脑或 EXE。</small>
              <div className="analysis-activation-controls">
                <input aria-label="Archtree 邮箱或用户名" autoComplete="username" value={archtreeIdentifier} onChange={(event) => setArchtreeIdentifier(event.target.value)} placeholder="邮箱或用户名"/>
                <input aria-label="Archtree 密码" type="password" autoComplete="current-password" value={archtreePassword} onChange={(event) => setArchtreePassword(event.target.value)} placeholder="密码"/>
                <button type="button" disabled={authenticating || !archtreeIdentifier.trim() || !archtreePassword} onClick={() => void loginAnalysis()}>
                  {authenticating ? <LoaderCircle className="spin" size={17}/> : <KeyRound size={17}/>} {authenticating ? '正在登录…' : '登录'}
                </button>
              </div>
              {authenticationError && <p role="alert">{authenticationError}</p>}
            </div>
          </section>
        )}

        {settings.analysis?.transport === 'proxy' && settings.analysis.account && (
          <section className="analysis-activation-card analysis-account-card" aria-label="Archtree 登录状态">
            <span className="analysis-activation-icon"><CircleCheck size={22}/></span>
            <div className="analysis-activation-copy">
              <strong>已登录 Archtree</strong>
              <small>{settings.analysis.account.email} · 登录有效</small>
              <button className="analysis-logout-button" type="button" disabled={authenticating} onClick={() => void logoutAnalysis()}>
                {authenticating ? <LoaderCircle className="spin" size={17}/> : <LogOut size={17}/>} {authenticating ? '正在退出…' : '退出或更换账号'}
              </button>
              {authenticationError && <p role="alert">{authenticationError}</p>}
            </div>
          </section>
        )}

        <section className={`chrome-connect-card chrome-connect-prominent ${chromeReady ? 'chrome-connected' : ''}`} aria-labelledby="chrome-connect-title">
          <div className="chrome-connect-heading">
            <span>{chromeReady ? <CircleCheck size={21}/> : <MonitorCog size={21}/>}</span>
            <div>
              <strong id="chrome-connect-title">{chromeReady ? '已连接你的 B站账号' : '连接已经登录 B站的 Chrome'}</strong>
              <small>{chromeReady
                ? `${chromeStatus?.accountName ?? '当前账号'}${chromeStatus?.accountUidSuffix ? ` · UID 尾号 ${chromeStatus.accountUidSuffix}` : ''}`
                : '无需填写端口、账号或 Cookie，工具会自动发现当前电脑上的 Chrome。'}</small>
            </div>
          </div>
          <p className={`chrome-connect-status ${chromeStatus?.state === 'error' || chromeStatus?.loginState === 'logged_out' ? 'warning' : ''}`}>
            {chromeReady ? <CircleCheck size={17}/> : chromeTransitioning ? <LoaderCircle className="spin" size={17}/> : <CircleAlert size={17}/>}
            <span>{chromeStatus?.message ?? '正在检测 Chrome…'}</span>
          </p>
          <div className="chrome-connect-actions">
            <button className="chrome-settings-button" type="button" disabled={chromeTransitioning} onClick={() => void onConnectChrome()}>
              {chromeTransitioning ? <LoaderCircle className="spin" size={18}/> : <MonitorCog size={18}/>} {chromeStatus?.state === 'disconnecting' ? '正在断开 Chrome…' : connectingChrome || chromeStatus?.state === 'connecting' ? '等待 Chrome 授权…' : chromeActionLabel}
            </button>
            <button className="chrome-guide-link" type="button" onClick={onOpenGuide}><BookOpen size={17}/>图文教程</button>
            {chromeStatus?.connected && <button className="chrome-guide-link" type="button" disabled={chromeTransitioning || (chromeStatus.activeInvestigations ?? 0) > 0} onClick={() => void onDisconnectChrome()}><Unplug size={17}/>断开</button>}
          </div>
          <p>工具只操作自己创建的调查标签页；连接期间请关闭网银、邮箱等敏感页面。</p>
        </section>

        <button className="primary-action" disabled={busy || durationMinutes < 1 || durationMinutes > 720 || maxSources < 3 || maxSources > 200 || keywordList.length === 0 || (!includeVideos && !includeDynamics) || (mode === 'live' && (!chromeReady || !settings.analysis?.aiConfigured))}>
          {busy ? '正在创建调查…' : mode === 'live' && !settings.analysis?.aiConfigured ? settings.analysis?.transport === 'direct' ? '配置 AI 后开始' : '登录 Archtree 后开始' : mode === 'live' && !chromeReady ? '连接 Chrome 后开始' : '开始调查'} <ArrowRight size={19}/>
        </button>
        <p className="compliance-copy">只读取公开可见页面；真实模式仅经私人服务器向 OpenAI 发送去标识化的评论分析语境。</p>
      </form>
    </main>
  );
};
