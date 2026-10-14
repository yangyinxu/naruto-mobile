import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {ChromeConnectionStatus} from '../types';
import {NewResearch} from './NewResearch';

const settings = {
  apiVersion: 5,
  dataRoot: 'D:/Research/naruto-mobile',
  analysis: {
    aiConfigured: true,
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    liveMode: 'ai' as const,
    demoMode: 'rule_demo' as const
  },
  defaults: {
    durationMinutes: 5,
    contentWindowDays: 30,
    keywords: ['火影忍者手游'],
    includeVideos: true,
    includeDynamics: true,
    mode: 'live' as const,
    browserVisible: true,
    browserWindowCount: 1,
    maxSources: 20
  }
};

const chromeProps = () => ({
  chromeStatus: {
    state: 'connected' as const,
    remoteDebuggingEnabled: true,
    connected: true,
    loginState: 'logged_in' as const,
    accountName: '测试玩家',
    accountUidSuffix: '1234',
    activeInvestigations: 0,
    message: 'Chrome 已连接。'
  },
  connectingChrome: false,
  onConnectChrome: vi.fn().mockResolvedValue(undefined),
  onDisconnectChrome: vi.fn().mockResolvedValue(undefined)
});

describe('NewResearch', () => {
  it('uses the shared browser login without collecting a password in the hosted UI', () => {
    render(<NewResearch {...chromeProps()} settings={{...settings, runtime: 'browser', dataRoot: '当前浏览器本地存储', analysis: {...settings.analysis, aiConfigured: false, transport: 'proxy', loginRequired: true}}} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByRole('link', {name: '前往 Archtree 登录'})).toHaveAttribute('href', '/auth/login-web?returnTo=%2Fnaruto%2F');
    expect(screen.queryByLabelText('Archtree 密码')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: '选择存放位置'})).not.toBeInTheDocument();
    expect(screen.getByText(/清除网站数据会删除本地调查/)).toBeVisible();
    expect(screen.getByText(/采集在独立的新 Chrome 窗口中运行/)).toBeVisible();
    expect(screen.getByRole('button', {name: '连接扩展并检查 B站'})).toBeVisible();
    expect(screen.getByRole('button', {name: '登录 Archtree 后开始'})).toBeDisabled();
    expect(screen.getByText('gpt-6-luna · 需要登录 Archtree')).toBeVisible();
    expect(screen.queryByText(/AI 分析服务暂不可用/)).not.toBeInTheDocument();
  });

  it.each(['browser', 'desktop'] as const)('explains unavailable AI service for a signed-in %s proxy user', (runtime) => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={{...settings, runtime, analysis: {...settings.analysis,
      aiConfigured: false, transport: 'proxy', loginRequired: false,
      account: {userId: '64b000000000000000000001', email: 'friend@example.com', role: 'user'}}}}
      busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByText('friend@example.com · 登录有效')).toBeVisible();
    expect(screen.getByText('gpt-6-luna · AI 分析服务暂不可用')).toBeVisible();
    expect(screen.getByText('AI 分析服务暂不可用，请稍后重试。')).toBeVisible();
    const start = screen.getByRole('button', {name: 'AI 分析服务暂不可用'});
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', {name: '登录 Archtree 后开始'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link', {name: '前往 Archtree 登录'})).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Archtree 密码')).not.toBeInTheDocument();
  });

  it('keeps direct desktop configuration guidance when no AI key is configured', () => {
    render(<NewResearch {...chromeProps()} settings={{...settings, runtime: 'desktop',
      analysis: {...settings.analysis, aiConfigured: false, transport: 'direct'}}}
      busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByText('gpt-6-luna · 需要配置 OpenAI API 密钥')).toBeVisible();
    expect(screen.getByRole('button', {name: '配置 AI 后开始'})).toBeDisabled();
    expect(screen.queryByText(/AI 分析服务暂不可用/)).not.toBeInTheDocument();
  });

  it('can start a local demo while the signed-in proxy AI service is unavailable', () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={{...settings, runtime: 'browser', analysis: {...settings.analysis,
      aiConfigured: false, transport: 'proxy', loginRequired: false,
      account: {userId: '64b000000000000000000001', email: 'friend@example.com', role: 'user'}}}}
      busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    fireEvent.click(screen.getByText('本地演示'));
    const start = screen.getByRole('button', {name: '开始调查'});
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({mode: 'demo', browserWindowCount: 1}));
  });
  it('enables the game prefix by default and submits the previewed topic searches', () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByRole('checkbox', {name: '自动添加「火影手游」前缀'})).toBeChecked();
    fireEvent.change(screen.getByLabelText(/关键词/), {target: {value: '十月活动\n新忍者评价，氪金意愿'}});
    expect(screen.getByLabelText('实际搜索词')).toHaveTextContent('火影手游 十月活动');
    expect(screen.getByLabelText('实际搜索词')).toHaveTextContent('火影手游 新忍者评价');
    expect(screen.getByLabelText('实际搜索词')).toHaveTextContent('火影手游 氪金意愿');
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({keywords: ['火影手游 十月活动', '火影手游 新忍者评价', '火影手游 氪金意愿']}));
  });

  it('can disable and re-enable the prefix without modifying the entered keywords', () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    const input = screen.getByLabelText(/关键词/);
    const toggle = screen.getByRole('checkbox', {name: '自动添加「火影手游」前缀'});
    fireEvent.change(input, {target: {value: ' 十月活动\n氪金意愿 '}});
    fireEvent.click(toggle);
    expect(input).toHaveValue(' 十月活动\n氪金意愿 ');
    expect(screen.getByLabelText('实际搜索词')).not.toHaveTextContent('火影手游');
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({keywords: ['十月活动', '氪金意愿']}));
    fireEvent.click(toggle);
    expect(input).toHaveValue(' 十月活动\n氪金意愿 ');
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({keywords: ['火影手游 十月活动', '火影手游 氪金意愿']}));
  });

  it('avoids duplicate game names and deduplicates the actual searches', () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={{...settings, defaults: {...settings.defaults, keywords: ['火影忍者手游', '火影手游决斗场', '火影手游高招']}}} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByLabelText(/关键词/)).toHaveValue('火影忍者手游\n决斗场\n高招');
    fireEvent.change(screen.getByLabelText(/关键词/), {target: {value: '十月活动\n火影手游 十月活动\n\n火影手游高招\n火影忍者手游 新忍者'}});
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({keywords: ['火影手游 十月活动', '火影手游高招', '火影忍者手游 新忍者']}));
    fireEvent.change(screen.getByLabelText(/关键词/), {target: {value: ' \n ， '}});
    expect(screen.queryByLabelText('实际搜索词')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: /开始调查/})).toBeDisabled();
  });

  it('checks the length limit after adding the prefix', () => {
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText(/关键词/), {target: {value: '活'.repeat(38)}});
    expect(screen.getByRole('alert')).toHaveTextContent('单个实际搜索词不能超过 40 个字符。');
    expect(screen.getByRole('button', {name: /开始调查/})).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', {name: '自动添加「火影手游」前缀'}));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: /开始调查/})).toBeEnabled();
  });

  it('starts with the beginner five-minute preset and submits canonical settings', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByText(/Luna 筛选强洞察/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      durationMinutes: 5,
      contentWindowDays: 30,
      mode: 'live'
    }));
  });

  it('allows a beginner to enter a custom collection duration', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('最长采集时长（分钟）'), {target: {value: '17'}});
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({durationMinutes: 17}));
  });

  it('shows advanced mode options without requiring expansion', () => {
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByText('高级选项')).toBeVisible();
    expect(screen.getByText(/真实调查 · Luna AI/)).toBeVisible();
    expect(screen.getByText('本地演示')).toBeVisible();
    expect(screen.getByLabelText('并行调查标签页数')).toBeVisible();
  });

  it('submits the selected live browser concurrency', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    const concurrency = screen.getByLabelText('并行调查标签页数');
    expect(concurrency).toHaveValue('4');
    expect(Array.from((concurrency as HTMLSelectElement).options).map((option) => option.value)).toEqual(['4', '8']);
    fireEvent.change(concurrency, {target: {value: '8'}});
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({browserWindowCount: 8}));
  });

  it('saves raw topics and the prefix choice, then restores them in a new form', async () => {
    const onSaveKeywords = vi.fn().mockResolvedValue(undefined);
    const props = {...chromeProps(), busy: false, selectingDataRoot: false, onStart: vi.fn().mockResolvedValue(undefined), onSelectDataRoot: vi.fn(), onOpenGuide: vi.fn(), onSaveKeywords};
    const view = render(<NewResearch {...props} settings={settings}/>);
    fireEvent.change(screen.getByLabelText(/关键词/), {target: {value: '十月活动\n火影手游 新忍者评价， 氪金意愿 '}});
    fireEvent.click(screen.getByRole('checkbox', {name: '自动添加「火影手游」前缀'}));
    fireEvent.click(screen.getByRole('button', {name: '保存关键词'}));
    const saved = {keywords: ['十月活动', '火影手游 新忍者评价', '氪金意愿'], useKeywordPrefix: false};
    await vi.waitFor(() => expect(onSaveKeywords).toHaveBeenCalledWith(saved));
    expect(await screen.findByText('已保存，下次打开自动使用。')).toBeVisible();
    view.unmount();
    render(<NewResearch {...props} settings={{...settings, defaults: {...settings.defaults, ...saved}}}/>);
    expect(screen.getByRole('checkbox', {name: '自动添加「火影手游」前缀'})).not.toBeChecked();
    expect(screen.getByLabelText(/关键词/)).toHaveValue(saved.keywords.join('\n'));
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(props.onStart).toHaveBeenCalledWith(expect.objectContaining({keywords: saved.keywords}));
  });

  it('keeps edited keywords available after a save error and permits retry', async () => {
    const onSaveKeywords = vi.fn().mockRejectedValueOnce(new Error('磁盘暂时不可写。')).mockResolvedValueOnce(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()} onSaveKeywords={onSaveKeywords}/>);
    fireEvent.change(screen.getByLabelText(/关键词/), {target: {value: '十月活动'}});
    fireEvent.click(screen.getByRole('button', {name: '保存关键词'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘暂时不可写。');
    expect(screen.getByLabelText(/关键词/)).toHaveValue('十月活动');
    fireEvent.click(screen.getByRole('button', {name: '保存关键词'}));
    expect(await screen.findByText('已保存，下次打开自动使用。')).toBeVisible();
    expect(onSaveKeywords).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText(/关键词/), {target: {value: ' '}});
    expect(screen.getByRole('button', {name: '保存关键词'})).toBeDisabled();
    expect(screen.queryByText('已保存，下次打开自动使用。')).not.toBeInTheDocument();
  });

  it('lets the user control the source limit instead of applying a hidden cap', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={onStart} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('最长采集时长（分钟）'), {target: {value: '3'}});
    fireEvent.change(screen.getByLabelText('最多采集来源数'), {target: {value: '60'}});
    expect(screen.getByText(/达到 3 分钟.*处理完 60 个来源/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: /开始调查/}));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({durationMinutes: 3, maxSources: 60}));
  });

  it('puts the beginner Chrome guide in a prominent position', () => {
    const onOpenGuide = vi.fn();
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={onOpenGuide}/>);
    fireEvent.click(screen.getByRole('button', {name: /图文教程/}));
    expect(onOpenGuide).toHaveBeenCalledOnce();
    expect(screen.getByText(/工具只操作自己创建的调查标签页/)).toBeInTheDocument();
  });

  it('requires a logged-in Chrome connection for live research but not demo mode', () => {
    const disconnectedStatus: ChromeConnectionStatus = {
      ...chromeProps().chromeStatus,
      state: 'ready',
      connected: false,
      loginState: 'unknown',
      accountName: undefined,
      accountUidSuffix: undefined,
      message: 'Chrome 已准备好。'
    };
    render(<NewResearch {...chromeProps()} chromeStatus={disconnectedStatus} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByRole('button', {name: /连接 Chrome 后开始/})).toBeDisabled();
    fireEvent.click(screen.getByText('本地演示'));
    expect(screen.getByRole('button', {name: /^开始调查/})).toBeEnabled();
  });

  it('locks connection actions until Chrome has completely disconnected', () => {
    const disconnectingStatus: ChromeConnectionStatus = {
      ...chromeProps().chromeStatus,
      state: 'disconnecting',
      message: '正在安全断开 Chrome，请稍候。'
    };
    render(<NewResearch {...chromeProps()} chromeStatus={disconnectingStatus} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={vi.fn()} onOpenGuide={vi.fn()}/>);
    expect(screen.getByRole('button', {name: /正在断开 Chrome/})).toBeDisabled();
    expect(screen.getByRole('button', {name: /^断开$/})).toBeDisabled();
    expect(screen.getByRole('button', {name: /连接 Chrome 后开始/})).toBeDisabled();
  });

  it('lets the user open the native data location picker', () => {
    const onSelectDataRoot = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch {...chromeProps()} settings={settings} busy={false} selectingDataRoot={false} onStart={vi.fn()} onSelectDataRoot={onSelectDataRoot} onOpenGuide={vi.fn()}/>);
    expect(screen.getByText(settings.dataRoot)).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: /选择存放位置/}));
    expect(onSelectDataRoot).toHaveBeenCalledOnce();
    expect(screen.getByText(/不会移动原文件/)).toBeVisible();
  });

  it('logs into any Archtree account without exposing an OpenAI key', async () => {
    const onLoginAnalysis = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch
      {...chromeProps()}
      settings={{...settings, analysis: {...settings.analysis, aiConfigured: false, loginRequired: true, transport: 'proxy'}}}
      busy={false}
      selectingDataRoot={false}
      onStart={vi.fn()}
      onSelectDataRoot={vi.fn()}
      onLoginAnalysis={onLoginAnalysis}
      onOpenGuide={vi.fn()}
    />);
    expect(screen.getByRole('button', {name: /登录 Archtree 后开始/})).toBeDisabled();
    expect(screen.getByText('gpt-6-luna · 需要登录 Archtree')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Archtree 邮箱或用户名'), {target: {value: 'friend@example.com'}});
    fireEvent.change(screen.getByLabelText('Archtree 密码'), {target: {value: 'private-password'}});
    fireEvent.click(screen.getByRole('button', {name: /^登录$/}));
    await vi.waitFor(() => expect(onLoginAnalysis).toHaveBeenCalledWith('friend@example.com', 'private-password'));
    expect(screen.queryByText(/OpenAI API 密钥/)).not.toBeInTheDocument();
  });

  it('shows the signed-in Archtree account and can log out', async () => {
    const onLogoutAnalysis = vi.fn().mockResolvedValue(undefined);
    render(<NewResearch
      {...chromeProps()}
      settings={{...settings, analysis: {
        ...settings.analysis,
        transport: 'proxy',
        account: {userId: '64b000000000000000000001', email: 'friend@example.com', role: 'user'}
      }}}
      busy={false}
      selectingDataRoot={false}
      onStart={vi.fn()}
      onSelectDataRoot={vi.fn()}
      onLogoutAnalysis={onLogoutAnalysis}
      onOpenGuide={vi.fn()}
    />);
    expect(screen.getByText('friend@example.com · 登录有效')).toBeVisible();
    expect(screen.getByText('gpt-6-luna 已就绪')).toBeVisible();
    expect(screen.getByRole('button', {name: '开始调查'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button', {name: /退出或更换账号/}));
    await vi.waitFor(() => expect(onLogoutAnalysis).toHaveBeenCalledOnce());
  });
});
