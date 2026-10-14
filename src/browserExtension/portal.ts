import {CHANNEL, isExtensionRequest, isPortalUrl} from './protocol';

declare const chrome: {runtime: {connect(options: {name: string}): {
  postMessage(value: unknown): void;
  onMessage: {addListener(callback: (value: unknown) => void): void};
  onDisconnect: {addListener(callback: () => void): void};
}}};

/** Bridges a top-level approved portal to packaged code; it never executes page commands. */
if (window === window.top && isPortalUrl(location.href)) {
  let port: ReturnType<typeof chrome.runtime.connect> | undefined;
  const origin = location.origin;
  const pending = new Set<string>();
  const post = (value: unknown) => window.postMessage(value, origin);
  const connect = () => {
    if (port) return port;
    port = chrome.runtime.connect({name: CHANNEL});
    port.onMessage.addListener((value) => {
      if (!isPortalUrl(location.href)) return;
      if (!value || typeof value !== 'object') return;
      const message = value as Record<string, unknown>;
      if (message.channel !== CHANNEL || !['response', 'event'].includes(String(message.direction))) return;
      if (message.direction === 'response') {
        if (typeof message.id !== 'string' || !pending.delete(message.id)) return;
      }
      post(message);
    });
    port.onDisconnect.addListener(() => {
      port = undefined;
      for (const id of pending) post({channel: CHANNEL, direction: 'response', id, error: '浏览器扩展连接已断开，请重新连接后继续调查。'});
      pending.clear();
    });
    return port;
  };
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== origin || !isPortalUrl(location.href) || !isExtensionRequest(event.data)) return;
    if (pending.has(event.data.id) || pending.size >= 32) return;
    pending.add(event.data.id);
    try { connect().postMessage(event.data); }
    catch { pending.delete(event.data.id); post({channel: CHANNEL, direction: 'response', id: event.data.id, error: '请重新加载扩展和调查页面。'}); }
  });
}
