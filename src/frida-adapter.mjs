import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WxError } from './errors.mjs';

export async function loadFrida() {
  try { return await import('frida'); }
  catch (error) { throw new WxError('E_FRIDA_UNAVAILABLE', `Frida 未安装或原生模块无法加载。请先运行 npm install。${error.message}`); }
}

export async function cancellableOperation(frida, operation, { signal, timeout = 15000 } = {}) {
  if (signal?.aborted) throw new WxError('E_ABORTED', '已取消。');
  const cancellable = new frida.Cancellable();
  const abort = () => cancellable.cancel();
  let timedOut = false;
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
  try { return await operation(cancellable); }
  catch (error) {
    if (signal?.aborted) throw new WxError('E_ABORTED', '已取消。');
    if (timedOut) throw new WxError('E_TIMEOUT', `Frida 操作在 ${timeout} 毫秒内未返回。`);
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export class FridaAdapter {
  constructor({ pid, candidates = [], expectedModulePath, signal, timeout = 15000 } = {}) {
    this.pid = pid;
    this.candidates = candidates;
    this.expectedModulePath = expectedModulePath;
    this.signal = signal;
    this.timeout = timeout;
    this.sessions = new Set();
    this.scripts = new Map();
  }

  async connect(source, onMessage, onDetached) {
    const frida = await loadFrida();
    const device = await frida.getLocalDevice();
    const pids = this.pid ? [this.pid] : this.candidates.map(p => p.pid);
    if (this.pid && !this.candidates.some(p => p.pid === this.pid)) throw new WxError('E_PID', '指定 PID 不属于已确认安装路径的微信进程。');
    if (!pids.length) throw new WxError('E_NOT_RUNNING', '未找到安装路径匹配的微信进程，请先启动微信。');
    const failures = [];
    for (const pid of pids) {
      let session;
      let script;
      try {
        session = await cancellableOperation(frida, c => device.attach(pid, {}, c), this);
        this.sessions.add(session);
        script = await cancellableOperation(frida, c => session.createScript(source, { name: 'wxcc-local-agent' }, c), this);
        this.scripts.set(session, script);
        if (onMessage) script.message.connect(onMessage);
        await cancellableOperation(frida, c => script.load(c), this);
        const metadata = await cancellableOperation(frida, c => script.exports.inspect(c), this);
        if (!metadata.mainModule) {
          await script.unload();
          await session.detach();
          this.sessions.delete(session);
          this.scripts.delete(session);
          continue;
        }
        if (this.expectedModulePath && resolve(metadata.mainModule.path).toLowerCase() !== resolve(this.expectedModulePath).toLowerCase()) {
          throw new WxError('E_MODULE_PATH', '运行模块路径与配置校验的 DLL 路径不一致。');
        }
        if (onDetached) session.detached.connect(onDetached);
        return { session, script, metadata };
      } catch (error) {
        if (session) { await cancellableOperation(frida, c => session.detach(c), { timeout: 5000 }).catch(() => {}); this.sessions.delete(session); this.scripts.delete(session); }
        if (this.signal?.aborted) throw error;
        failures.push({ pid, reason: error.message });
      }
    }
    throw new WxError('E_ATTACH', `无法连接包含 Weixin.dll 的微信进程。${failures.map(f => ` PID ${f.pid}: ${f.reason}`).join(';')}`, failures);
  }

  async inspect() {
    const source = await readFile(new URL('../agents/inspect.js', import.meta.url), 'utf8');
    const connection = await this.connect(source);
    try { return connection.metadata; }
    finally { await this.close(); }
  }

  async close() {
    if (!this.sessions.size) return;
    const frida = await loadFrida();
    const sessions = [...this.sessions];
    const results = await Promise.allSettled(sessions.map(async session => {
      const script = this.scripts.get(session);
      try {
        if (script && !script.isDestroyed) await cancellableOperation(frida, c => script.unload(c), { timeout: 5000 });
      } finally {
        await cancellableOperation(frida, c => session.detach(c), { timeout: 5000 });
      }
      this.sessions.delete(session);
      this.scripts.delete(session);
    }));
    const errors = results.filter(r => r.status === 'rejected');
    if (errors.length) throw new WxError('E_CLEANUP', `连接清理失败：${errors.map(e => e.reason.message).join('; ')}`);
  }
}
