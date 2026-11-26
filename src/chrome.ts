import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.ts';

export interface Profile {
  dir: string;
  name: string;
  email: string | null;
  lastUsed: boolean;
}

interface LocalStateProfile {
  info_cache?: Record<string, { name?: string; user_name?: string }>;
  last_used?: string;
}

export function defaultChromeRoot(): string {
  switch (process.platform) {
    case 'darwin': return join(homedir(), 'Library/Application Support/Google/Chrome');
    case 'win32': return join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/User Data');
    default: return join(homedir(), '.config/google-chrome');
  }
}

function localState(root: string): LocalStateProfile {
  const file = join(root, 'Local State');
  if (!existsSync(file)) throw new CliError('PROFILE_NOT_FOUND', `No Chrome data at ${root}`, 'Pass --user-data-dir for a non-default Chrome install', 3);
  return JSON.parse(readFileSync(file, 'utf8')).profile ?? {};
}

export function listProfiles(root: string): Profile[] {
  const { info_cache = {}, last_used } = localState(root);
  return Object.entries(info_cache).map(([dir, p]) => ({
    dir, name: p.name ?? dir, email: p.user_name || null, lastUsed: dir === last_used,
  }));
}

/** wanted: directory name ("Profile 70"), bare number, display name or email. Omitted: last used. */
export function resolveProfile(root: string, wanted?: string): Profile {
  const profiles = listProfiles(root);
  const w = wanted?.toLowerCase();
  const notFound = () => new CliError('PROFILE_NOT_FOUND', `No Chrome profile matches "${wanted ?? '(last used)'}"`, `Run \`notion2md profiles\`. Known: ${profiles.map((p) => p.dir).join(', ')}`, 3);
  if (w === undefined) {
    const last = profiles.find((p) => p.lastUsed) ?? profiles[0];
    if (!last) throw notFound();
    return last;
  }
  const exact = profiles.find((p) => p.dir.toLowerCase() === w)
    ?? profiles.find((p) => /^\d+$/.test(w) && p.dir.toLowerCase() === `profile ${w}`);
  if (exact) return exact;
  // Names and emails are not unique in Chrome, and guessing would read the wrong account.
  const named = profiles.filter((p) => p.email?.toLowerCase() === w || p.name.toLowerCase() === w);
  if (named.length > 1) {
    throw new CliError('PROFILE_AMBIGUOUS', `"${wanted}" matches ${named.length} profiles: ${named.map((p) => p.dir).join(', ')}`, 'Pass the profile dir name instead, e.g. --profile "Profile 20"', 3);
  }
  if (!named[0]) throw notFound();
  return named[0];
}

export interface Clone {
  tmp: string;
  /** Most Notion cookies either cookie layout holds. The copy Chrome reads may hold fewer, so withSession checks there. */
  cookies: number;
}

// Chrome refuses automation on its default data dir (v136+) and locks a profile that is open,
// so work on a throwaway copy holding only the cookies of `hosts`. Google cookies and the signed-in
// Preferences must stay out: a clone that sees the browser account without its refresh token can
// sign the real profile out of Google server-side.
export function cloneProfile(root: string, dir: string, hosts: string[]): Clone {
  const tmp = mkdtempSync(join(tmpdir(), 'notion2md-'));
  cpSync(join(root, 'Local State'), join(tmp, 'Local State'));
  let cookies = 0;
  for (const f of ['Cookies', 'Network/Cookies']) {
    const src = join(root, dir, f);
    if (!existsSync(src)) continue;
    const dst = join(tmp, dir, f);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
    cookies = Math.max(cookies, keepCookies(dst, hosts));
  }
  return { tmp, cookies };
}

function keepCookies(file: string, hosts: string[]): number {
  const db = new DatabaseSync(file);
  try {
    const del = db.prepare('DELETE FROM cookies WHERE host_key = ?');
    for (const { host_key } of db.prepare('SELECT DISTINCT host_key FROM cookies').all() as { host_key: string }[]) {
      const h = host_key.replace(/^\./, '');
      if (!hosts.some((k) => h === k || h.endsWith(`.${k}`))) del.run(host_key);
    }
    return (db.prepare('SELECT count(*) AS n FROM cookies').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Lax';
}

/** The key Chrome encrypts cookies with. Only macOS Chrome is handled: undefined elsewhere, and when the Keychain refuses. */
export function keychainPassword(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

// Chrome 130+ puts sha256(host_key) in front of the value, so a cookie cannot be replayed on another host.
function decryptCookie(key: Buffer, host: string, stored: Uint8Array): string | undefined {
  const enc = Buffer.from(stored);
  if (enc.subarray(0, 3).toString() !== 'v10') return undefined;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);
    const hashed = plain.length >= 32 && plain.subarray(0, 32).equals(createHash('sha256').update(host).digest());
    return (hashed ? plain.subarray(32) : plain).toString('utf8');
  } catch {
    // A key that does not belong to this profile gives bad padding: the cookie is unreadable, not a crash.
    return undefined;
  }
}

/**
 * Decrypts the cookies of a `cloneProfile` copy. It has to run before Chrome opens the copy: a Chrome that decrypts
 * per profile deletes the rows it cannot read, which is why the copy alone cannot log in.
 */
export function readCookies(tmp: string, dir: string, password: string): SessionCookie[] {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const found = new Map<string, SessionCookie>();
  for (const f of ['Cookies', 'Network/Cookies']) {
    const file = join(tmp, dir, f);
    if (!existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare('SELECT host_key, name, path, is_secure, is_httponly, encrypted_value FROM cookies').all() as
        { host_key: string; name: string; path: string; is_secure: number; is_httponly: number; encrypted_value: Uint8Array }[];
      for (const r of rows) {
        const value = decryptCookie(key, r.host_key, r.encrypted_value);
        if (value === undefined) continue;
        found.set(`${r.host_key}|${r.path}|${r.name}`, { name: r.name, value, domain: r.host_key, path: r.path, secure: r.is_secure === 1, httpOnly: r.is_httponly === 1, sameSite: 'Lax' });
      }
    } finally {
      db.close();
    }
  }
  return [...found.values()];
}
