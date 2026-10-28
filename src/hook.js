// Claude Code PreToolUse hook for Bash: trim noisy output at the source.
//
// A proxy only ever sees tool output after it exists. This hook runs before the command does and
// rewrites a handful of chatty commands into quieter forms with the same information (git with
// --short/--oneline, package managers and test runners with their quiet flags, no colour, no
// progress bars). The output is smaller in the request that carries it and in every request after,
// which no paging can match. Commands it does not recognise are left exactly as typed.
//
// Installed into ~/.claude/settings.json by `ccpager hook install`; invoked as `ccpager hook run`
// with the hook's JSON on stdin. It answers with `updatedInput` (Claude Code 2.x) and never blocks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NO_COLOR = 'NO_COLOR=1 CLICOLOR=0 TERM=dumb';

/** Rewrite rules: [matcher over the first command of a pipeline, replacement]. Order matters. */
const RULES = [
  // git
  [/^git status$/, 'git status --short --branch'],
  [/^git diff(\s.*)?$/, (m) => /--stat|--name-only|--numstat|--shortstat/.test(m[1] || '') ? null : `git --no-pager diff --no-color${m[1] || ''}`],
  [/^git log$/, 'git --no-pager log --oneline -n 30'],
  [/^git log\s+(.*)$/, (m) => /--oneline|--format|--pretty|-n\s|-\d/.test(m[1]) ? `git --no-pager log ${m[1]}` : `git --no-pager log --oneline -n 30 ${m[1]}`],
  [/^git (show|blame)(\s.*)?$/, (m) => `git --no-pager ${m[1]}${m[2] || ''}`],
  [/^git (push|pull|fetch|clone)(\s.*)?$/, (m) => /--quiet|-q\b/.test(m[2] || '') ? null : `git ${m[1]} --quiet${m[2] || ''}`],
  // node ecosystem
  [/^npm (install|i|ci|update|uninstall|remove)(\s.*)?$/, (m) => `npm ${m[1]} --no-fund --no-audit --loglevel=error --no-progress${m[2] || ''}`],
  [/^npm test$/, `${NO_COLOR} npm test --silent 2>&1 | tail -n 60`],
  [/^npm run (\S+)$/, (m) => `${NO_COLOR} npm run ${m[1]} --silent 2>&1 | tail -n 80`],
  [/^(npx )?(jest|vitest)(\s.*)?$/, (m) => `${NO_COLOR} ${m[1] || ''}${m[2]} --silent${m[3] || ''} 2>&1 | tail -n 80`],
  [/^(pnpm|yarn) (install|add|remove)(\s.*)?$/, (m) => `${m[1]} ${m[2]} --silent${m[3] || ''}`],
  // python
  [/^(python3? -m )?pytest(\s.*)?$/, (m) => /-q|--quiet/.test(m[2] || '') ? null : `${NO_COLOR} ${m[1] || ''}pytest -q --no-header -p no:cacheprovider${m[2] || ''} 2>&1 | tail -n 80`],
  [/^pip3? install(\s.*)?$/, (m) => /-q\b/.test(m[1] || '') ? null : `pip install -q --progress-bar off${m[1] || ''}`],
  // build tools and others
  [/^cargo (build|test|check|run)(\s.*)?$/, (m) => /-q\b|--quiet/.test(m[2] || '') ? null : `cargo ${m[1]} -q${m[2] || ''}`],
  [/^(go test|go build)(\s.*)?$/, (m) => `${m[1]}${m[2] || ''} 2>&1 | tail -n 80`],
  [/^make(\s.*)?$/, (m) => /-s\b|--silent/.test(m[1] || '') ? null : `make -s${m[1] || ''} 2>&1 | tail -n 80`],
  [/^docker build(\s.*)?$/, (m) => /-q\b|--quiet/.test(m[1] || '') ? null : `docker build -q${m[1] || ''}`],
  [/^(curl|wget)(\s.*)?$/, (m) => /-s\b|--silent|-q\b|--quiet/.test(m[2] || '') ? null : `${m[1]} ${m[1] === 'curl' ? '-sS' : '-q'}${m[2] || ''}`],
  [/^(apt|apt-get) (install|update|upgrade)(\s.*)?$/, (m) => `${m[1]} ${m[2]} -q${m[3] || ''}`],
  [/^tree(\s.*)?$/, (m) => /-L\s*\d/.test(m[1] || '') ? null : `tree -L 2 --noreport${m[1] || ''}`],
  [/^ls -la?(\s.*)?$/, (m) => /\|/.test(m[1] || '') ? null : `ls -la${m[1] || ''} | head -n 100`],
];

/** Rewrite one command string, or return null when it should run as typed. */
export function rewriteCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  const c = cmd.trim();
  // Only simple commands: no pipes, chaining, redirection or heredocs — those were written on purpose.
  if (!c || /[|&;<>`$(]|\n/.test(c)) return null;
  for (const [re, to] of RULES) {
    const m = c.match(re);
    if (!m) continue;
    const out = typeof to === 'function' ? to(m) : to;
    return out && out !== c ? out : null;
  }
  return null;
}

/** Handle one hook invocation: parse stdin JSON, answer with updatedInput when a rule applies. */
export function handleHook(input) {
  let j;
  try { j = typeof input === 'string' ? JSON.parse(input) : input; } catch { return null; }
  if (j?.tool_name !== 'Bash' || !j.tool_input?.command) return null;
  const cmd = rewriteCommand(j.tool_input.command);
  if (!cmd) return null;
  // No permissionDecision: the rewritten command still goes through the user's normal permission flow.
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...j.tool_input, command: cmd } } };
}

const SETTINGS = () => path.join(process.env.CCPAGER_HOME || os.homedir(), '.claude', 'settings.json');
const MARK = 'ccpager hook run';

function readSettings(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }

/** Add (or remove) the PreToolUse hook entry in Claude Code's settings. Returns what changed. */
export function installHook({ remove = false, command = 'ccpager hook run', file = SETTINGS() } = {}) {
  const s = readSettings(file);
  s.hooks ||= {};
  const list = Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : [];
  const kept = list.filter((e) => !(e.hooks || []).some((h) => String(h.command || '').includes(MARK)));
  if (!remove) kept.push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 5 }] });
  if (kept.length) s.hooks.PreToolUse = kept; else delete s.hooks.PreToolUse;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  return { file, installed: !remove, had: kept.length !== list.length || remove };
}

export function hookInstalled(file = SETTINGS()) {
  const s = readSettings(file);
  return (s.hooks?.PreToolUse || []).some((e) => (e.hooks || []).some((h) => String(h.command || '').includes(MARK)));
}
