export class UserError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.name = 'UserError';
    this.detail = detail;
  }
}

export function plain(value) {
  return String(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?');
}

export function describe(error) {
  if (error instanceof UserError) {
    return `${plain(error.message)}${error.detail ? `\n详细信息：${plain(error.detail.trim())}` : ''}`;
  }
  return `操作未完成，请检查路径、权限或磁盘空间。\n详细信息：${plain(error.message)}`;
}
