import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chromium, type BrowserContext } from 'playwright-core';
import { cloneProfile, listProfiles, readCookies, resolveProfile } from '../src/chrome.ts';

function chromeDir(info_cache: Record<string, { name?: string; user_name?: string }>, last_used?: string) {
  const root = mkdtempSync(join(tmpdir(), 'notion2md-chrome-'));
  writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache, last_used } }));
  return root;
}

const PROFILES = {
  Default: { name: 'Me', user_name: 'me@x.com' },
  'Profile 20': { name: 'Work', user_name: 'dup@x.com' },
  'Profile 21': { name: 'Sam', user_name: 'dup@x.com' },
  'Profile 70': { name: 'Alex Doe 2', user_name: 'alex@x.com' },
  'Profile 49': { name: 'example.com' },
  'Profile 71': { name: 'example.com' },
};

test('resolveProfile: dir, bare number, name and email all pick the same profile, case-insensitive', () => {
  const root = chromeDir(PROFILES, 'Default');
  try {
    for (const w of ['Profile 70', 'profile 70', '70', 'Alex Doe 2', 'alex doe 2', 'alex@x.com', 'ALEX@X.COM']) {
      assert.equal(resolveProfile(root, w).dir, 'Profile 70', w);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('resolveProfile: no argument takes the last used profile, or the first when none is marked', () => {
  const root = chromeDir(PROFILES, 'Profile 21');
  const none = chromeDir(PROFILES);
  try {
    assert.equal(resolveProfile(root).dir, 'Profile 21');
    assert.equal(resolveProfile(none).dir, 'Default');
  } finally {
    rmSync(root, { recursive: true });
    rmSync(none, { recursive: true });
  }
});

test('resolveProfile: unknown, and names or emails shared by several profiles, are errors with exit 3', () => {
  const root = chromeDir(PROFILES);
  try {
    assert.throws(() => resolveProfile(root, 'nope'), { code: 'PROFILE_NOT_FOUND', exit: 3 });
    assert.throws(() => resolveProfile(root, '99'), { code: 'PROFILE_NOT_FOUND', exit: 3 });
    assert.throws(() => resolveProfile(root, 'dup@x.com'), { code: 'PROFILE_AMBIGUOUS', exit: 3, message: /Profile 20, Profile 21/ });
    assert.throws(() => resolveProfile(root, 'example.com'), { code: 'PROFILE_AMBIGUOUS' });
    assert.equal(resolveProfile(root, 'Profile 20').dir, 'Profile 20');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('resolveProfile and listProfiles: empty profile list and missing Local State', () => {
  const empty = chromeDir({});
  const missing = mkdtempSync(join(tmpdir(), 'notion2md-chrome-'));
  try {
    assert.deepEqual(listProfiles(empty), []);
    assert.throws(() => resolveProfile(empty), { code: 'PROFILE_NOT_FOUND', exit: 3 });
    assert.throws(() => listProfiles(missing), { code: 'PROFILE_NOT_FOUND', exit: 3 });
  } finally {
    rmSync(empty, { recursive: true });
    rmSync(missing, { recursive: true });
  }
});

test('cloneProfile: keeps only Local State and the cookies of the given hosts, no Preferences', () => {
  const root = chromeDir(PROFILES);
  mkdirSync(join(root, 'Default/Network'), { recursive: true });
  mkdirSync(join(root, 'Default/Cache'), { recursive: true });
  const db = new DatabaseSync(join(root, 'Default/Network/Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT)');
  for (const h of ['.notion.so', 'www.notion.so', '.google.com', 'accounts.google.com', 'evilnotion.so']) {
    db.prepare('INSERT INTO cookies VALUES (?, ?)').run(h, 'c');
  }
  db.close();
  writeFileSync(join(root, 'Default/Preferences'), '{}');
  writeFileSync(join(root, 'Default/Cache/big'), 'x');
  const { tmp, cookies } = cloneProfile(root, 'Default', ['notion.so']);
  try {
    assert.deepEqual(
      ['Local State', 'Default/Network/Cookies', 'Default/Preferences', 'Default/Cache/big'].filter((f) => existsAt(tmp, f)),
      ['Local State', 'Default/Network/Cookies'],
    );
    assert.equal(cookies, 2);
    const kept = new DatabaseSync(join(tmp, 'Default/Network/Cookies'));
    assert.deepEqual(
      (kept.prepare('SELECT host_key FROM cookies ORDER BY host_key').all() as { host_key: string }[]).map((r) => r.host_key),
      ['.notion.so', 'www.notion.so'],
    );
    kept.close();
  } finally {
    rmSync(root, { recursive: true });
    rmSync(tmp, { recursive: true });
  }
});

test('cloneProfile: older Chrome keeps cookies at the profile root, and they are filtered the same way', () => {
  const root = chromeDir(PROFILES);
  mkdirSync(join(root, 'Default'), { recursive: true });
  const db = new DatabaseSync(join(root, 'Default/Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT)');
  for (const h of ['.notion.so', '.google.com']) db.prepare('INSERT INTO cookies VALUES (?, ?)').run(h, 'c');
  db.close();
  const { tmp, cookies } = cloneProfile(root, 'Default', ['notion.so']);
  try {
    assert.equal(cookies, 1);
    const kept = new DatabaseSync(join(tmp, 'Default/Cookies'));
    assert.deepEqual((kept.prepare('SELECT host_key FROM cookies').all() as { host_key: string }[]).map((r) => r.host_key), ['.notion.so']);
    kept.close();
  } finally {
    rmSync(root, { recursive: true });
    rmSync(tmp, { recursive: true });
  }
});

test('cloneProfile: with both cookie layouts, the larger count wins, so a login in either is not missed', () => {
  const root = chromeDir(PROFILES);
  mkdirSync(join(root, 'Default/Network'), { recursive: true });
  for (const [f, hosts] of [['Default/Cookies', ['.notion.so', '.www.notion.so', '.notion.so']], ['Default/Network/Cookies', ['.notion.so']]] as const) {
    const db = new DatabaseSync(join(root, f));
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT)');
    for (const h of hosts) db.prepare('INSERT INTO cookies VALUES (?, ?)').run(h, 'c');
    db.close();
  }
  const { tmp, cookies } = cloneProfile(root, 'Default', ['notion.so']);
  try {
    assert.equal(cookies, 3);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(tmp, { recursive: true });
  }
});

const existsAt = (dir: string, rel: string) => existsSync(join(dir, rel));

const CREATE_COOKIES = `CREATE TABLE cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
  path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite,
  source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor)`;

test('cloneProfile: Chrome reads the cookies of the copy, so a logged in profile can be used from it', async (t) => {
  const root = chromeDir(PROFILES);
  mkdirSync(join(root, 'Default'), { recursive: true });
  const db = new DatabaseSync(join(root, 'Default/Cookies'));
  db.exec(CREATE_COOKIES);
  db.prepare(`INSERT INTO cookies VALUES (1, '.notion.so', '', 'plain_probe', 'hello', x'', '/', 20000000000000000,
    1, 0, 1, 1, 1, 1, -1, 2, 443, 1, 0, 0)`).run();
  db.close();
  const { tmp, cookies } = cloneProfile(root, 'Default', ['notion.so']);
  let ctx: BrowserContext | undefined;
  try {
    try {
      ctx = await chromium.launchPersistentContext(tmp, { channel: 'chrome', headless: true, args: ['--profile-directory=Default'] });
    } catch (e) {
      t.skip(`no Chrome to test with: ${(e as Error).message.split('\n')[0]}`);
      return;
    }
    assert.equal(cookies, 1);
    // Chrome deletes the rows it cannot decrypt, and an unreadable login is the failure this test exists for.
    assert.deepEqual((await ctx.cookies()).map((c) => c.name), ['plain_probe']);
  } finally {
    await ctx?.close();
    rmSync(root, { recursive: true });
    rmSync(tmp, { recursive: true });
  }
});

/** What macOS Chrome stores: "v10" + AES-128-CBC, and since Chrome 130 sha256(host) in front of the value. */
function encrypt(password: string, host: string, value: string, hostHash: boolean, version = 'v10') {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([hostHash ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(value)]);
  return Buffer.concat([Buffer.from(version), cipher.update(plain), cipher.final()]);
}

test('readCookies: decrypts both cookie layouts, drops the host hash, and skips what it cannot read', () => {
  const root = mkdtempSync(join(tmpdir(), 'notion2md-cookies-'));
  const insert = (file: string, rows: [host: string, name: string, secure: number, httpOnly: number, enc: Uint8Array][]) => {
    mkdirSync(join(root, 'Default', file, '..'), { recursive: true });
    const db = new DatabaseSync(join(root, 'Default', file));
    db.exec(CREATE_COOKIES);
    const add = db.prepare('INSERT INTO cookies (host_key, name, path, is_secure, is_httponly, encrypted_value) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [host, name, secure, httpOnly, enc] of rows) add.run(host, name, '/', secure, httpOnly, enc);
    db.close();
  };
  try {
    insert('Cookies', [
      ['.notion.so', 'token_v2', 1, 1, encrypt('pw', '.notion.so', 'secret', true)],
      ['.notion.so', 'old_style', 1, 0, encrypt('pw', '.notion.so', 'no-hash', false)],
      ['.notion.so', 'wrong_key', 1, 0, encrypt('other', '.notion.so', 'x', true)],
      ['.notion.so', 'v11', 1, 0, encrypt('pw', '.notion.so', 'x', true, 'v11')],
      ['.notion.so', 'plain', 1, 0, new Uint8Array()],
    ]);
    insert('Network/Cookies', [['.notion.com', 'notion_user_id', 0, 0, encrypt('pw', '.notion.com', 'u1', true)]]);
    const got = readCookies(root, 'Default', 'pw');
    assert.deepEqual(got.map((c) => [c.domain, c.name, c.value, c.secure, c.httpOnly]).sort(), [
      ['.notion.com', 'notion_user_id', 'u1', false, false],
      ['.notion.so', 'old_style', 'no-hash', true, false],
      ['.notion.so', 'token_v2', 'secret', true, true],
    ]);
    assert.deepEqual(readCookies(mkdtempSync(join(tmpdir(), 'notion2md-nocookies-')), 'Default', 'pw'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
