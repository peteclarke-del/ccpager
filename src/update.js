// Version checks and in-place updates.
//
// The check asks GitHub's releases API for the newest release (one small GET, at most once a
// day unless forced; nothing else is sent). The update then depends on how ccpager was installed:
//   git     a clone (install.sh / npm link): `git pull --ff-only`
//   deb     the Debian package (/usr/lib/ccpager): download the release's .deb, verify its
//           SHA-256 against the release's SHA256SUMS, install it with pkexec (or sudo in a terminal)
//   manual  an unpacked archive: nothing automatic; the release page is offered instead
// Afterwards the caller restarts the gateway (and the window), since the running code is old.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { ROOT, VERSION } from './version.js';

export { VERSION };
export const REPO = 'peteclarke-del/ccpager';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
const LATEST_URL = () => process.env.CCPAGER_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY = 24 * 3600e3;

/** Numeric semver comparison: 1 if a > b, -1 if a < b, 0 if equal. Pre-release tags sort below the release. */
export function compareVersions(a, b) {
  const parse = (v) => { const [main, pre] = String(v).replace(/^v/, '').split('-'); return { n: main.split('.').map((x) => parseInt(x, 10) || 0), pre: pre || null }; };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) { const d = (A.n[i] || 0) - (B.n[i] || 0); if (d) return d > 0 ? 1 : -1; }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  return A.pre && B.pre ? (A.pre > B.pre ? 1 : A.pre < B.pre ? -1 : 0) : 0;
}

/** How this copy was installed, which decides how it can be updated. */
export function installKind(root = ROOT) {
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  if (fs.existsSync(path.join(root, 'package-target'))) return 'deb';
  return 'manual';
}

/** Reduce a GitHub release object to what the CLI and window need. */
export function parseRelease(rel, current = VERSION) {
  const latest = String(rel?.tag_name || rel?.name || '').replace(/^v/, '');
  if (!latest) return null;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const deb = assets.find((a) => /\.deb$/.test(a.name));
  const sums = assets.find((a) => a.name === 'SHA256SUMS');
  return {
    current, latest, newer: compareVersions(latest, current) > 0,
    url: rel.html_url || `${RELEASES_URL}/tag/v${latest}`,
    publishedAt: rel.published_at || null,
    notes: typeof rel.body === 'string' ? rel.body.trim() : '',
    deb: deb ? { name: deb.name, url: deb.browser_download_url, size: deb.size } : null,
    sums: sums ? sums.browser_download_url : null,
  };
}

const cacheFile = (dataDir) => path.join(dataDir, 'update.json');
export function readUpdateCache(dataDir) {
  try { return JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8')); } catch { return null; }
}

/**
 * Look for a newer release. Uses the cached answer when it is under a day old unless `force`.
 * Never throws: on a network failure it returns the cached result (if any) with `error` set.
 */
export async function checkForUpdate({ dataDir, force = false, now = Date.now(), fetchImpl = fetch, current = VERSION } = {}) {
  const kind = installKind();
  const cached = dataDir ? readUpdateCache(dataDir) : null;
  if (!force && cached?.release && now - cached.checkedAt < CHECK_EVERY) {
    return { ...parseRelease(cached.release, current), kind, checkedAt: cached.checkedAt, cached: true };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetchImpl(LATEST_URL(), { headers: { accept: 'application/vnd.github+json', 'user-agent': `ccpager/${current}` }, signal: ctl.signal });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = await res.json();
    const parsed = parseRelease(release, current);
    if (!parsed) throw new Error('no release found');
    if (dataDir) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(cacheFile(dataDir), JSON.stringify({ checkedAt: now, release }, null, 2)); }
    return { ...parsed, kind, checkedAt: now, cached: false };
  } catch (e) {
    const base = cached?.release ? { ...parseRelease(cached.release, current), checkedAt: cached.checkedAt, cached: true } : { current, latest: null, newer: false, url: RELEASES_URL };
    return { ...base, kind, error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(timer); }
}

/** Download a release's .deb into `dir` and verify it against the release's SHA256SUMS. */
export async function downloadDeb(check, dir, fetchImpl = fetch) {
  if (!check.deb) throw new Error('this release has no Debian package');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, check.deb.name);
  const res = await fetchImpl(check.deb.url, { headers: { 'user-agent': `ccpager/${VERSION}` }, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  if (check.sums) {
    const sums = await (await fetchImpl(check.sums, { redirect: 'follow' })).text();
    const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, '') === check.deb.name)?.[0];
    if (!want) throw new Error('SHA256SUMS does not list the package');
    const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (got !== want) { fs.unlinkSync(file); throw new Error('checksum mismatch; download discarded'); }
  }
  return file;
}

/**
 * Apply an update for this install kind. Returns a short description of what was done.
 * `file` is the downloaded .deb for kind 'deb'. Runs the privileged step through pkexec when a
 * display is available (the desktop asks for the password), otherwise sudo.
 */
export function applyUpdate({ kind = installKind(), file, root = ROOT, interactive = true } = {}) {
  if (kind === 'git') {
    execFileSync('git', ['-C', root, 'pull', '--ff-only', '--quiet'], { stdio: interactive ? 'inherit' : 'pipe' });
    return 'pulled the latest code';
  }
  if (kind === 'deb') {
    if (!file) throw new Error('no package file to install');
    const elevate = process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? 'pkexec' : 'sudo';
    const apt = spawnSync('sh', ['-c', 'command -v apt-get'], { stdio: 'pipe' }).status === 0;
    const args = apt ? ['apt-get', 'install', '-y', '--allow-downgrades', file] : ['dpkg', '-i', file];
    const r = spawnSync(elevate, args, { stdio: interactive ? 'inherit' : 'pipe' });
    if (r.status !== 0) throw new Error(`${elevate} ${args[0]} failed${r.status === 126 || r.status === 127 ? ' (authorisation cancelled)' : ` (exit ${r.status})`}`);
    return `installed ${path.basename(file)}`;
  }
  throw new Error(`ccpager was unpacked by hand, so it can't update itself. Download the new version from ${RELEASES_URL}`);
}
