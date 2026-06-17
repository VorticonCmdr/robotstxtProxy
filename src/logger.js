// Minimal leveled logger — no dependency. Writes single-line JSON-ish records to stderr
// so stdout stays clean and logs are easy to grep/ship.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] > threshold) return;
    const parts = [`level=${lvl}`, `msg=${JSON.stringify(msg)}`];
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
    }
    process.stderr.write(parts.join(' ') + '\n');
  }

  return {
    error: (msg, fields) => emit('error', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
  };
}
