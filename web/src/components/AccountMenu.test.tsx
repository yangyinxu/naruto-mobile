import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {AccountMenu} from './AccountMenu';

const signedIn = {
  aiConfigured: true,
  model: 'gpt-6-luna',
  reasoningEffort: 'medium',
  liveMode: 'ai' as const,
  demoMode: 'rule_demo' as const,
  transport: 'proxy' as const,
  account: {userId: '64b000000000000000000001', email: 'friend@example.com', role: 'user' as const}
};

describe('AccountMenu', () => {
  it('renders nothing without a signed-in proxy account', () => {
    const {container, rerender} = render(<AccountMenu analysis={{...signedIn, account: undefined, loginRequired: true}} onLogout={vi.fn()}/>);
    expect(container).toBeEmptyDOMElement();
    rerender(<AccountMenu analysis={{...signedIn, transport: 'direct'}} onLogout={vi.fn()}/>);
    expect(container).toBeEmptyDOMElement();
    rerender(<AccountMenu analysis={undefined} onLogout={vi.fn()}/>);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the account and logs out from the menu', async () => {
    const onLogout = vi.fn().mockResolvedValue(undefined);
    render(<AccountMenu analysis={signedIn} onLogout={onLogout}/>);
    const trigger = screen.getByRole('button', {name: 'Archtree 账号 friend@example.com'});
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Archtree 登录有效 · AI 分析已就绪')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: /退出或更换账号/}));
    await vi.waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('keeps the menu open with the error when logout fails', async () => {
    const onLogout = vi.fn().mockRejectedValue(new Error('网络暂时不可用。'));
    render(<AccountMenu analysis={{...signedIn, aiConfigured: false, loginRequired: false}} onLogout={onLogout}/>);
    fireEvent.click(screen.getByRole('button', {name: /Archtree 账号/}));
    expect(screen.getByText('Archtree 登录有效 · AI 分析服务暂不可用')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: /退出或更换账号/}));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络暂时不可用。');
    expect(screen.getByRole('button', {name: /退出或更换账号/})).toBeEnabled();
  });

  it('returns focus to the trigger on Escape from inside the panel', () => {
    render(<AccountMenu analysis={signedIn} onLogout={vi.fn()}/>);
    const trigger = screen.getByRole('button', {name: /Archtree 账号/});
    fireEvent.click(trigger);
    const logout = screen.getByRole('button', {name: /退出或更换账号/});
    logout.focus();
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('closes when focus leaves the menu and when the account changes', () => {
    const {rerender} = render(<div><AccountMenu analysis={signedIn} onLogout={vi.fn()}/><button>elsewhere</button></div>);
    const trigger = screen.getByRole('button', {name: /Archtree 账号/});
    fireEvent.click(trigger);
    fireEvent.blur(trigger, {relatedTarget: screen.getByRole('button', {name: 'elsewhere'})});
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    rerender(<div><AccountMenu analysis={{...signedIn, account: {...signedIn.account, userId: 'other', email: 'other@example.com'}}} onLogout={vi.fn()}/><button>elsewhere</button></div>);
    expect(screen.getByRole('button', {name: 'Archtree 账号 other@example.com'})).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on Escape and on an outside click', () => {
    render(<div><AccountMenu analysis={signedIn} onLogout={vi.fn()}/><p>outside</p></div>);
    const trigger = screen.getByRole('button', {name: /Archtree 账号/});
    fireEvent.click(trigger);
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
