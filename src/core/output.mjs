const REDACTED_KEYS = /authorization|cookie|token|secret|password/i;

export function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, REDACTED_KEYS.test(key) ? '[REDACTED]' : redact(entry)]),
    );
  }

  return value;
}

export function jsonResult(data) {
  return JSON.stringify(redact(data), null, 2);
}

export function errorResult(error, json) {
  const data = {
    ok: false,
    error: {
      code: error.code || 'internal_error',
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };

  return json ? jsonResult(data) : `Error: ${data.error.message}`;
}