/** Web Locks are mandatory for mutation; absence fails closed instead of racing another tab. */
export class BrowserRunLocks {
  constructor(private readonly manager: LockManager | undefined = globalThis.navigator?.locks) {}

  acquire(id: string): Promise<() => void> {
    if (!this.manager) return Promise.reject(new Error('此浏览器不支持安全的跨页面调查锁，请使用最新版 Chrome。'));
    return new Promise((resolve, reject) => {
      let release: () => void;
      const holding = new Promise<void>((done) => {release = done;});
      void this.manager!.request(`naruto:run:${id}`, {ifAvailable: true}, async (lock) => {
        if (!lock) {reject(new Error('该调查正在另一个页面中运行，请返回原页面操作。')); return;}
        resolve(() => release());
        await holding;
      }).catch(reject);
    });
  }
}
