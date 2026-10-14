import type {ExtensionBridge, ExtensionEvent} from './types';

const channel = 'naruto-extension-v1';
const eventTypes = new Set(['state', 'candidates', 'content', 'opinion', 'checkpoint', 'warning', 'complete']);

/** Only accepts messages sent to this page by its same-origin extension content script. */
export class ChromeExtensionBridge implements ExtensionBridge {
  private readonly listeners = new Set<(event: ExtensionEvent) => void>();
  private readonly pending = new Map<string, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();

  constructor(private readonly page: Window = window, private readonly timeoutMs = 45_000) {
    page.addEventListener('message', this.onMessage);
  }

  private readonly onMessage = (event: MessageEvent) => {
    if (event.source !== this.page || event.origin !== this.page.location.origin) return;
    const value = event.data;
    if (!value || typeof value !== 'object' || value.channel !== channel) return;
    if (value.direction === 'response' && typeof value.id === 'string') {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error !== undefined) pending.reject(new Error(typeof value.error === 'string'
        ? value.error.slice(0, 500) : '扩展操作失败，请检查扩展状态。'));
      else pending.resolve(value.result);
    } else if (value.direction === 'event' && typeof value.runId === 'string' && eventTypes.has(value.type)) {
      for (const listener of this.listeners) listener(value as ExtensionEvent);
    }
  };

  request<T>(method: string, payload?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = globalThis.crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('未收到 Chrome 扩展响应。请安装并启用火影调查扩展，然后刷新此页面。'));
      }, method === 'status' ? Math.min(this.timeoutMs, 1200) : this.timeoutMs);
      this.pending.set(id, {resolve: (value) => resolve(value as T), reject, timer});
      this.page.postMessage({channel, direction: 'request', id, method, payload}, this.page.location.origin);
    });
  }

  subscribe(listener: (event: ExtensionEvent) => void) {
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  }

  dispose() {
    this.page.removeEventListener('message', this.onMessage);
    for (const pending of this.pending.values()) {clearTimeout(pending.timer); pending.reject(new Error('页面已关闭。'));}
    this.pending.clear();
    this.listeners.clear();
  }
}
