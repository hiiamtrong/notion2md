import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { cloneProfile, listProfiles, resolveProfile } from '../src/chrome.ts';

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
  const tmp = cloneProfile(root, 'Default', ['notion.so']);
  try {
    assert.deepEqual(
      ['Local State', 'Default/Network/Cookies', 'Default/Preferences', 'Default/Cache/big'].filter((f) => existsAt(tmp, f)),
      ['Local State', 'Default/Network/Cookies'],
    );
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
  const tmp = cloneProfile(root, 'Default', ['notion.so']);
  try {
    const kept = new DatabaseSync(join(tmp, 'Default/Cookies'));
    assert.deepEqual((kept.prepare('SELECT host_key FROM cookies').all() as { host_key: string }[]).map((r) => r.host_key), ['.notion.so']);
    kept.close();
  } finally {
    rmSync(root, { recursive: true });
    rmSync(tmp, { recursive: true });
  }
});

const existsAt = (dir: string, rel: string) => existsSync(join(dir, rel));
