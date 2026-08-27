import {useState} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  Keyboard,
  LoaderCircle,
  MonitorCog,
  ShieldCheck,
  Unplug
} from 'lucide-react';
import {ChromeConnectionStatus} from '../types';

interface Props {
  chromeSettingsSupported: boolean;
  chromeStatus?: ChromeConnectionStatus;
  connectingChrome: boolean;
  onBack: () => void;
  onOpenChromeSettings: () => Promise<void>;
  onConnectChrome: () => Promise<void>;
  onDisconnectChrome: () => Promise<void>;
}

const CHROME_SETTINGS_URL = 'chrome://inspect/#remote-debugging';

export const ChromeGuide = ({
  chromeSettingsSupported,
  chromeStatus,
  connectingChrome,
  onBack,
  onOpenChromeSettings,
  onConnectChrome,
  onDisconnectChrome
}: Props) => {
  const [opening, setOpening] = useState(false);
  const [openMessage, setOpenMessage] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const chromeTransitioning = connectingChrome
    || chromeStatus?.state === 'connecting'
    || chromeStatus?.state === 'disconnecting';
  const chromeReady = chromeStatus?.state === 'connected'
    && chromeStatus.connected
    && chromeStatus.loginState === 'logged_in';

  const openSettings = async () => {
    setOpening(true);
    setOpenMessage('');
    try {
      await onOpenChromeSettings();
      setOpenMessage('已经请求 Chrome 打开设置页。如果没有看到新页面，请使用下方的复制地址方法。');
    } catch {
      setOpenMessage('自动打开没有成功，请使用下方的复制地址方法。');
    } finally {
      setOpening(false);
    }
  };

  const copyAddress = async () => {
    setCopyMessage('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(CHROME_SETTINGS_URL);
      setCopyMessage('地址已复制。现在回到 Chrome，按 Ctrl + L、Ctrl + V，再按回车。');
    } catch {
      setCopyMessage('未能自动复制。请点击地址框后按 Ctrl + C，再粘贴到 Chrome 地址栏。');
    }
  };

  return (
    <main className="guide-page content-width">
      <button className="back-button guide-back" type="button" onClick={onBack}><ArrowLeft size={17}/>返回新建调查</button>

      <section className="guide-hero">
        <div>
          <span className="guide-kicker"><MonitorCog size={18}/>首次使用设置</span>
          <h1>3 分钟完成 Chrome 连接准备</h1>
          <p>按照下面四步完成 Chrome 端准备。你不需要输入 B站账号、不需要导出 Cookie，也不需要关闭日常使用的 Chrome。</p>
        </div>
        <div className="guide-time"><strong>约 3 分钟</strong><span>只需设置一次</span></div>
      </section>

      <aside className="guide-security-note">
        <ShieldCheck size={24}/>
        <div><strong>开始前请先了解</strong><p>远程调试会让你批准的本地程序读取和操作当前 Chrome。建议先关闭网银、邮箱等敏感标签页；Chrome 弹出连接请求时，请确认是你刚刚启动的调查操作再点“允许”。</p></div>
      </aside>

      <aside className={`guide-version-note ${chromeReady ? 'connected' : ''}`}>
        {chromeReady ? <Check size={22}/> : <CircleAlert size={22}/>}
        <div><strong>{chromeReady ? 'Chrome 和 B站均已就绪' : '工具会自动发现连接地址'}</strong><p>{chromeReady
          ? `当前使用 B站账号：${chromeStatus?.accountName ?? '已登录用户'}。返回后可以直接开始真实调查。`
          : '你不需要填写 9222 或复制 Cookie。打开开关后，工具会从当前电脑安全地发现 Chrome。'}</p></div>
      </aside>

      <div className="guide-steps">
        <section className="guide-step">
          <span className="guide-step-number">1</span>
          <div className="guide-step-body">
            <h2>准备日常使用的 Chrome</h2>
            <p>保持你平时使用的 Chrome 开启，并确认同一个窗口里的 B站已经登录。请不要使用无痕窗口。</p>
            <ul>
              <li><Check size={16}/>Chrome 保持打开</li>
              <li><Check size={16}/>B站显示已登录</li>
              <li><Check size={16}/>关闭不希望工具看到的敏感标签页</li>
            </ul>
          </div>
        </section>

        <section className="guide-step guide-step-action">
          <span className="guide-step-number">2</span>
          <div className="guide-step-body">
            <h2>打开 Chrome 的连接设置页</h2>
            <p>先尝试自动打开。如果 Chrome 没有跳转，这是浏览器对内部地址的正常限制，使用下面的手动方法即可。</p>
            <button className="guide-primary-button" type="button" disabled={opening || !chromeSettingsSupported} onClick={() => void openSettings()}>
              <ExternalLink size={18}/>{opening ? '正在尝试打开…' : chromeSettingsSupported ? '尝试自动打开设置页' : '重新启动工具后可用'}
            </button>
            {!chromeSettingsSupported && <p className="guide-inline-warning"><CircleAlert size={16}/>请关闭旧的 CMD 窗口并重新双击启动工具。已保存的数据不会丢失。</p>}
            {openMessage && <p className="guide-feedback" role="status">{openMessage}</p>}

            <div className="manual-address">
              <div className="manual-address-heading"><Keyboard size={18}/><strong>没有打开？手动复制地址</strong></div>
              <div className="address-row">
                <input aria-label="Chrome 连接设置地址" readOnly value={CHROME_SETTINGS_URL} onFocus={(event) => event.currentTarget.select()}/>
                <button type="button" onClick={() => void copyAddress()}><Copy size={17}/>复制地址</button>
              </div>
              <p>回到 Chrome 后，按 <kbd>Ctrl</kbd> + <kbd>L</kbd>，再按 <kbd>Ctrl</kbd> + <kbd>V</kbd>，最后按回车。</p>
              {copyMessage && <p className="guide-feedback" role="status">{copyMessage}</p>}
            </div>
          </div>
        </section>

        <section className="guide-step">
          <span className="guide-step-number">3</span>
          <div className="guide-step-body">
            <h2>打开“允许远程调试”开关</h2>
            <p>在设置页找到下面这项并打开。不同语言的 Chrome 可能显示中文或英文：</p>
            <div className="chrome-switch-example" aria-label="需要打开的 Chrome 设置示例">
              <span className="fake-switch"><i/></span>
              <div><strong>允许对此浏览器实例进行远程调试</strong><small>Allow remote debugging for this browser instance</small></div>
            </div>
            <p className="guide-muted">这个开关属于 Chrome 的安全设置，网页不能替你点击。你可以在调查结束后回到这里关闭它。</p>
          </div>
        </section>

        <section className="guide-step">
          <span className="guide-step-number">4</span>
          <div className="guide-step-body">
            <h2>完成设置并连接</h2>
            <p>点击下面的按钮后，Chrome 会询问是否允许连接。确认是本工具发起的请求后点击“允许”，工具会自动检查 B站是否已经登录。</p>
            <p className={`guide-connection-result ${chromeStatus?.loginState === 'logged_out' || chromeStatus?.state === 'error' ? 'warning' : ''}`} role="status">
              {chromeStatus?.message ?? '正在检测 Chrome…'}
            </p>
            {chromeReady ? (
              <div className="guide-finish-actions">
                <button className="guide-finish-button" type="button" onClick={onBack}>连接成功，返回新建调查 <ArrowRight size={18}/></button>
                <button className="guide-disconnect-button" type="button" disabled={chromeTransitioning || (chromeStatus?.activeInvestigations ?? 0) > 0} onClick={() => void onDisconnectChrome()}><Unplug size={18}/>断开 Chrome</button>
              </div>
            ) : (
              <button className="guide-finish-button" type="button" disabled={chromeTransitioning || !chromeStatus?.remoteDebuggingEnabled} onClick={() => void onConnectChrome()}>
                {chromeTransitioning ? <LoaderCircle className="spin" size={18}/> : <MonitorCog size={18}/>} {chromeStatus?.state === 'disconnecting' ? '正在断开 Chrome…' : connectingChrome || chromeStatus?.state === 'connecting' ? '等待 Chrome 授权…' : chromeStatus?.connected ? '重新检查 B站登录' : '连接并检查 B站'}
              </button>
            )}
          </div>
        </section>
      </div>

      <section className="guide-troubleshooting">
        <h2>还是不行？先看这里</h2>
        <div>
          <article><strong>点击后只打开了普通 Chrome</strong><p>不要反复点击，直接复制上面的地址，粘贴到 Chrome 地址栏并回车。</p></article>
          <article><strong>找不到“允许远程调试”</strong><p>确认地址完整，并更新到较新的 Chrome；无痕窗口不支持这个设置。</p></article>
          <article><strong>为什么没有连接授权提示</strong><p>先确认远程调试开关已经打开，再返回本页点击“连接并检查 B站”。弹窗可能出现在其他 Chrome 窗口中。</p></article>
          <article><strong>显示尚未登录 B站</strong><p>在同一个普通 Chrome 窗口中完成登录，然后回到这里点击“重新检查 B站登录”。不要使用无痕窗口。</p></article>
        </div>
      </section>
    </main>
  );
};
