import {FocusEvent, useEffect, useRef, useState} from 'react';
import {ChevronDown, LoaderCircle, LogOut, UserRound} from 'lucide-react';
import {AppSettings} from '../types';

interface Props {
  analysis: AppSettings['analysis'];
  onLogout: () => Promise<void>;
}

/** The signed-in Archtree account in the top bar; signing in happens on the new-research page. */
export const AccountMenu = ({analysis, onLogout}: Props) => {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const account = analysis?.transport === 'proxy' ? analysis.account : undefined;

  // A different (or no) account starts with a closed menu and no stale logout error.
  useEffect(() => {
    setOpen(false);
    setError('');
  }, [account?.userId]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Only reclaim focus that was inside the menu; a user who tabbed elsewhere keeps their place.
      if (root.current?.contains(document.activeElement)) trigger.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  if (!account) return null;
  const unavailable = !analysis?.loginRequired && !analysis?.aiConfigured;

  const closeWhenFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) setOpen(false);
  };

  const logout = async () => {
    setLeaving(true);
    setError('');
    try {
      await onLogout();
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="account-menu" ref={root} onBlur={closeWhenFocusLeaves}>
      <button className="account-trigger" type="button" ref={trigger} aria-expanded={open} aria-controls="account-menu-panel" aria-label={`Archtree 账号 ${account.email}`} onClick={() => setOpen((current) => !current)}>
        <span className="account-avatar" aria-hidden="true"><UserRound size={17}/></span>
        <span className="account-email">{account.email}</span>
        <ChevronDown size={15} aria-hidden="true"/>
      </button>
      {open && (
        <div className="account-panel" id="account-menu-panel">
          <strong>{account.email}</strong>
          <small>{unavailable ? 'Archtree 登录有效 · AI 分析服务暂不可用' : 'Archtree 登录有效 · AI 分析已就绪'}</small>
          <button type="button" disabled={leaving} onClick={() => void logout()}>
            {leaving ? <LoaderCircle className="spin" size={16}/> : <LogOut size={16}/>} {leaving ? '正在退出…' : '退出或更换账号'}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
};
