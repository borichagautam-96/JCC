#!/usr/bin/env node
// Run the test suite against a THROWAWAY database.
//
// The tests exercise real routes, which means they create real users, jobs, reworks
// and annexures. Previously they ran against ./database.db — the same file the app
// serves — so every run silently left rows behind. Those leftovers were invisible in
// the UI only by accident (the coordinator queue inner-joins the creator, and the
// test users get deleted), which made them easy to miss and impossible to trust.
//
// server/database.js already honours DB_PATH; the tests simply never set it. This
// points them at a scratch file, creates it fresh, and deletes it afterwards, so a
// test run can never touch live data.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDbPath = path.join(os.tmpdir(), `jcc-test-${process.pid}-${Date.now()}.db`);

// Journals live alongside the database file; clear all three.
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${testDbPath}${suffix}`, { force: true }); } catch { /* already gone */ }
  }
};
const finish = (code) => { cleanup(); process.exit(code); };

const envFile = path.join(projectRoot, '.env');
const childEnv = {
  ...process.env,
  // Set AFTER --env-file is read, so it wins even if .env names a DB_PATH.
  DB_PATH: testDbPath,
  NODE_ENV: 'test',
};

function runTests() {
  const args = ['--test'];
  if (fs.existsSync(envFile)) args.push(`--env-file=${envFile}`);
  args.push('server/tests/*.test.js');

  const child = spawn(process.execPath, args, { cwd: projectRoot, stdio: 'inherit', env: childEnv });
  child.on('exit', (code, signal) => finish(signal ? 1 : (code ?? 1)));
  child.on('error', (err) => { console.error('Failed to start tests:', err); finish(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); cleanup(); });
}

// Create and migrate the scratch database in a throwaway process FIRST. The test
// runner executes files in parallel, and against an empty file they would otherwise
// all race to create tables and seed the admin user — producing "database is locked"
// and duplicate-key errors that have nothing to do with the code under test. Doing it
// once up front (and letting that process exit, releasing the lock) leaves the test
// files opening an already-initialised database, exactly as they used to.
const init = spawn(
  process.execPath,
  [...(fs.existsSync(envFile) ? [`--env-file=${envFile}`] : []),
   '-e', "import('./server/database.js').then(() => process.exit(0))"],
  { cwd: projectRoot, stdio: ['ignore', 'ignore', 'inherit'], env: childEnv },
);

init.on('exit', (initCode) => {
  if (initCode !== 0) {
    console.error(`Could not prepare the test database (exit ${initCode})`);
    return finish(1);
  }
  runTests();
});
