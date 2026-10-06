export class WxError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'WxError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function unsupported(capability, version) {
  return new WxError('E_UNSUPPORTED', `微信 ${version ?? '未知版本'} 的 ${capability} 尚未完成接入验证。`, { capability, version });
}
