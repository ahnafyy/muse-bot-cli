export const EXIT_CODE = Object.freeze({
  SUCCESS: 0,
  OPERATION: 1,
  USAGE: 2,
  AUTH: 3,
  COMPATIBILITY: 4,
});

export class CliError extends Error {
  constructor(message, { code = 'operation_failed', exitCode = EXIT_CODE.OPERATION, details } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}