/** 统一的 worker 错误类型：带机器可读的 code，便于 MCP 工具返回结构化错误。 */
export type WorkerErrorCode =
  | 'invalid_cwd'
  | 'cwd_not_writable'
  | 'task_not_found'
  | 'task_not_finished'
  | 'quota_exceeded'
  | 'bad_request'
  | 'internal';

export class WorkerError extends Error {
  readonly code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
  }
}
