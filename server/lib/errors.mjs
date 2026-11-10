export class AppError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    Object.assign(this, { status, code, retryable });
  }
}
export const badRequest = (message) => new AppError(400, 'INVALID_INPUT', message);
export function safeError(error) {
  return error instanceof AppError
    ? error.message
    : 'Die Verarbeitung ist fehlgeschlagen. Bitte erneut versuchen.';
}
