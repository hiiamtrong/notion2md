import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const BIN = join(import.meta.dirname, '../bin/notion-md.ts');
const ID = '0123456789abcdef0123456789abcdef';

// Every case below must fail before a browser is launched, so these run in milliseconds.
// --user-data-dir points at an empty dir: if validation were skipped, the run would end with exit 3, never launch Chrome.
const scratch = mkdtempSync(join(tmpdir(), 'notion-md-cli-'));
const run = (...args: string[]) => spawnSync(process.execPath, [BIN, '--user-data-dir', scratch, ...args], { encoding: 'utf8' });

test('bad usage exits 2 with a code on stderr and nothing on stdout', () => {
  const file = join(scratch, 'afile');
  writeFileSync(file, '');
  const cases: [string[], string][] = [
    [[], 'BAD_INPUT'],
    [['a', 'b'], 'BAD_INPUT'],
    [['hello'], 'BAD_INPUT'],
    [[ID, '-d', 'x'], 'BAD_INPUT'],
    [[ID, '-d', '1'], 'BAD_INPUT'],
    [[ID, '-d', 'all'], 'BAD_INPUT'],
    [[ID, '--timeout', 'abc'], 'BAD_INPUT'],
    [[ID, '--timeout', '0'], 'BAD_INPUT'],
    [[`https://attacker.example/x-${ID}`], 'BAD_INPUT'],
    [[ID, '-d', '1', '-o', file], 'BAD_INPUT'],
    [[ID, '-d', '1', '-o', join(file, 'sub')], 'BAD_INPUT'],
  ];
  for (const [args, code] of cases) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, new RegExp(`^error\\[${code}\\]`), args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
});

test('with --json a failure is also a JSON object on stdout', () => {
  const r = run(`https://attacker.example/${ID}`, '--json');
  assert.equal(r.status, 2);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'BAD_INPUT');
});

test('a valid request with an unusable Chrome dir exits 3, which also proves validation passed first', () => {
  const r = run(ID, '-p', '70');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^error\[PROFILE_NOT_FOUND\]/);
});

test('--help exits 0 and documents every exit code and the folder layout', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  for (const word of ['EXIT CODES', 'FOLDER OUTPUT', '--progress', '--depth']) assert.ok(r.stdout.includes(word), word);
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));
