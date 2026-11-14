// Which kind of session is a request part of?
//
// Claude Code runs subagents (Explore, file-search specialists, helpers) as separate sessions with
// their own system prompt. They are where a large share of plan usage goes: the same search on
// Opus costs 4x what it costs on Sonnet and 40x what it costs on Haiku. That is the only lever big
// enough to change work-per-token by a factor, so the gateway identifies them here.
//
// The markers are matched against `system` ONLY. A user message, a file or a tool result can contain
// any text at all, and a false positive would move the user's main conversation to a smaller model
// for the whole session — far worse than failing to spot a subagent. So: system prompt, or nothing.

const MARKERS = [
  [/You are a file search specialist/i, 'file-search specialist'],
  [/You are an agent for Claude Code/i, 'Claude Code subagent'],
  [/You are a specialized agent/i, 'specialized agent'],
  [/\bExplore agent\b/i, 'Explore agent'],
  [/You are a subagent/i, 'subagent'],
  [/general-purpose agent/i, 'general-purpose agent'],
];

function systemText(body) {
  const s = body?.system;
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) return s.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
}

/** { kind: 'helper' | 'main', marker } from the system prompt. */
export function classify(body) {
  const sys = systemText(body).slice(0, 8000);
  for (const [re, marker] of MARKERS) if (re.test(sys)) return { kind: 'helper', marker };
  return { kind: 'main', marker: null };
}
