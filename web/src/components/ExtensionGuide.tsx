import {useState} from 'react';
import {ArrowLeft, Check, Copy, Download, LoaderCircle, Puzzle, ShieldCheck, Unplug} from 'lucide-react';
import {ChromeConnectionStatus} from '../types';
import {isExtensionOutdated, latestExtensionVersion} from '../browser/extensionVersion';

interface Props {
  chromeStatus?: ChromeConnectionStatus;
  connectingChrome: boolean;
  onBack: () => void;
  onConnectChrome: () => Promise<void>;
  onDisconnectChrome: () => Promise<void>;
}

/** Explains the browser collector's explicit installation and device-local data boundary. */
export const ExtensionGuide = ({chromeStatus, connectingChrome, onBack, onConnectChrome, onDisconnectChrome}: Props) => {
  const [message, setMessage] = useState('');
  const ready = chromeStatus?.connected && chromeStatus.loginState === 'logged_in';
  const installedOutdated = Boolean(chromeStatus?.extensionVersion) && isExtensionOutdated(chromeStatus?.extensionVersion);
  const connect = async () => {
    setMessage('');
    try { await onConnectChrome(); } catch (error) { setMessage(error instanceof Error ? error.message : '连接失败，请重试。'); }
  };
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText('chrome://extensions');
      setMessage('已复制。在 Chrome 地址栏粘贴并打开。');
    } catch { setMessage('请手动在 Chrome 地址栏输入 chrome://extensions。'); }
  };
  return <main className="guide-page content-width">
    <button className="back-button guide-back" type="button" onClick={onBack}><ArrowLeft size={17}/>返回新建调查</button>
    <section className="guide-hero"><div><span className="guide-kicker"><Puzzle size={18}/>浏览器版首次设置</span><h1>用 Chrome 扩展在本机采集</h1><p>在已登录 B站的 Chrome 中启用采集扩展，再回到此网页创建调查。</p></div></section>
    <aside className="guide-security-note"><ShieldCheck size={24}/><div><strong>原始数据留在你的浏览器</strong><p>扩展读取 B站公开页面，只管理自己创建的调查标签页。原文、缓存和报告保存在当前浏览器；AI 分析仅发送去标识化的评论语境。请导出调查 ZIP 备份，清除网站数据会删除本地调查。</p></div></aside>
    <div className="guide-steps">
      <section className="guide-step"><span className="guide-step-number">1</span><div className="guide-step-body"><h2>下载并解压采集扩展</h2><p>将压缩包解压到一个固定文件夹，保留这个文件夹供 Chrome 使用。</p><p>当前版本 {latestExtensionVersion}。{installedOutdated && `你安装的是 ${chromeStatus?.extensionVersion}，需要更新。`}已经安装时，用新版文件替换原文件夹内容，在扩展管理页点击“重新加载”，再刷新调查网页。</p><a className="guide-primary-button" href={`${import.meta.env.BASE_URL}naruto-mobile-chrome-extension.zip`} download><Download size={18}/>下载 Chrome 扩展</a></div></section>
      <section className="guide-step"><span className="guide-step-number">2</span><div className="guide-step-body"><h2>在 Chrome 中加载扩展</h2><p>打开下面的地址，开启右上角“开发者模式”，点击“加载已解压的扩展程序”，选择包含 manifest.json 的解压文件夹。</p><div className="address-row"><input aria-label="Chrome 扩展管理地址" value="chrome://extensions" readOnly onFocus={(event) => event.currentTarget.select()}/><button type="button" onClick={() => void copyAddress()}><Copy size={17}/>复制地址</button></div></div></section>
      <section className="guide-step"><span className="guide-step-number">3</span><div className="guide-step-body"><h2>登录 B站，回到网页连接</h2><p>在同一个 Chrome 的普通窗口中登录 B站，刷新调查网页，然后点击下面的按钮检查连接。你无需复制 Cookie。</p><button className="guide-primary-button" type="button" disabled={connectingChrome} onClick={() => void connect()}>{connectingChrome ? <LoaderCircle size={18} className="spin"/> : <Check size={18}/>}连接扩展并检查 B站</button>{ready && <p className="guide-feedback" role="status">B站已登录，可以开始调查。</p>}{chromeStatus?.message && <p>{chromeStatus.message}</p>}</div></section>
      <section className="guide-step"><span className="guide-step-number">4</span><div className="guide-step-body"><h2>保持调查网页打开，并备份调查</h2><p>采集会新开一个独立 Chrome 窗口，标签页集中到橙色“火影调查”标签页组并自动静音，评论区会自动滚动并等待加载。</p><p>后台评论仍未加载时，只在独立采集窗口内切换标签页重试，不切换你原窗口的页面，也不主动把采集窗口带到前台。</p><p>采集和分析期间请保持此网页打开。关闭后再打开，可以从已保存的进度和缓存继续。历史调查中的“导出调查”可保存 ZIP，并在网页版或 EXE 中导入。</p><button className="guide-primary-button" type="button" onClick={onBack}>返回并创建调查</button></div></section>
    </div>
    {chromeStatus?.connected && <button className="secondary-action" type="button" disabled={connectingChrome || chromeStatus.activeInvestigations > 0} onClick={() => void onDisconnectChrome().catch((error) => setMessage(error.message))}><Unplug size={17}/>断开扩展</button>}
    {message && <p className="guide-feedback" role="status">{message}</p>}
  </main>;
};
