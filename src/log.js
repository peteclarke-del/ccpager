import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

export const logPath = (dataDir) => path.join(dataDir, 'ccpager.log');

/**
 * The gateway writes its own log file, so it exists on every OS whether it runs
 * under launchd, systemd (which would otherwise send output to the journal),
 * a Windows startup script (which discards output), or a terminal.
 * Never logs prompt or response content, only per-request counts.
 */
export function createLogger(dataDir, { echo = true } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = logPath(dataDir);
  try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch {}
  let n = 0;
  const write = (level, args) => {
    if (++n % 500 === 0) { try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch {} }
    const line = `${new Date().toISOString()} ${level} ${args.map(String).join(' ')}\n`;
    try { fs.appendFileSync(file, line); } catch {}
    if (echo) (level === 'ERROR' ? process.stderr : process.stdout).write(line);
  };
  return {
    file,
    log: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
  };
}
