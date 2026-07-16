#!/usr/bin/env node
/**
 * Build ya-namp as a single self-contained executable using Node 22
 * Single Executable Applications (SEA).
 *
 * WHAT THIS PRODUCES
 *   dist/ya-namp/
 *     server/dist/ya-namp[.exe]   ← the binary (node runtime + bundled server)
 *     client/dist/…               ← the SPA, shipped ALONGSIDE the binary
 *
 * WHY THE ALONGSIDE LAYOUT
 *   The server resolves its assets at  path.resolve(__dirname,'../../client/dist').
 *   Inside a Node SEA, __dirname === the directory holding the executable
 *   (empirically verified), so a binary at  server/dist/ya-namp  looks for
 *   client/dist at  server/dist/../../client/dist === <pkg>/client/dist.
 *   Mirroring the repo layout therefore makes the server find and serve the SPA
 *   with ZERO edits to server/src. The token is supplied via the YANDEX_TOKEN
 *   env var (the server reads it first), or a .env dropped next to the binary at
 *   <pkg>/.env.
 *
 *   For a TRULY single-file binary (assets embedded, nothing alongside) see the
 *   "clean approach" section of docs/single-binary.md — it needs one small
 *   server/src change, spelled out there.
 *
 * SEA CANNOT CROSS-COMPILE: the produced binary targets the OS/arch of the Node
 * you run this with. For cross-platform binaries use Bun (see docs/single-binary.md).
 *
 * Usage:  node scripts/build-binary.mjs        (or: npm run build:binary)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const BUILD = path.join(ROOT, 'build', 'sea');
const OUT = path.join(ROOT, 'dist', 'ya-namp');
const BIN = path.join(OUT, 'server', 'dist', isWin ? 'ya-namp.exe' : 'ya-namp');

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  // On Windows, `npm` and the `esbuild.cmd` shim are batch scripts — Node 22
  // won't spawn a .cmd without a shell (spawnSync ENOENT otherwise). The node
  // binary itself (process.execPath) runs directly.
  const shell = isWin && cmd !== process.execPath;
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell, ...opts });
}

function step(msg) {
  console.log(`\n==> ${msg}`);
}

// 1. Make sure the SPA is built.
step('Ensuring client/dist exists');
const clientDist = path.join(ROOT, 'client', 'dist');
if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
  console.log('  client/dist missing — building it');
  run('npm', ['run', 'build', '-w', 'client']);
} else {
  console.log('  client/dist present');
}

// 2. Bundle the server as CJS (SEA main must be CommonJS). esbuild does NOT
//    shim import.meta.url for CJS, so we define it from __filename (which the
//    SEA sets to the executable path) via a banner.
step('Bundling server → build/sea/server.cjs (CJS)');
fs.mkdirSync(BUILD, { recursive: true });
const esbuild = path.join(ROOT, 'node_modules', '.bin', isWin ? 'esbuild.cmd' : 'esbuild');
run(esbuild, [
  'server/src/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node22',
  '--packages=bundle',
  '--define:import.meta.url=__IM_URL__',
  '--banner:js=const __IM_URL__=require("url").pathToFileURL(__filename).href;',
  `--outfile=${path.join(BUILD, 'server.cjs')}`,
]);

// 3. Generate the SEA preparation blob.
step('Generating SEA blob');
const seaConfig = {
  main: path.join(BUILD, 'server.cjs'),
  output: path.join(BUILD, 'server.blob'),
  disableExperimentalSEAWarning: true,
};
const configPath = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));
run(process.execPath, ['--experimental-sea-config', configPath]);

// 4. Copy the Node runtime to the output path and inject the blob.
step('Assembling binary');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.dirname(BIN), { recursive: true });
fs.copyFileSync(process.execPath, BIN);
fs.chmodSync(BIN, 0o755);

if (isMac) {
  // macOS invalidates the signature when the Mach-O is modified — strip it,
  // inject into a dedicated segment, then ad-hoc re-sign.
  try {
    execFileSync('codesign', ['--remove-signature', BIN], { stdio: 'ignore' });
  } catch {
    console.log('  (no existing signature to remove)');
  }
}

step('Injecting SEA blob (postject)');
const { inject } = require('postject');
const blob = fs.readFileSync(path.join(BUILD, 'server.blob'));
await inject(BIN, 'NODE_SEA_BLOB', blob, {
  sentinelFuse: SENTINEL,
  ...(isMac ? { machoSegmentName: 'NODE_SEA' } : {}),
});

if (isMac) {
  step('Re-signing binary (ad-hoc)');
  execFileSync('codesign', ['--sign', '-', BIN], { stdio: 'inherit' });
}

// 5. Ship client/dist alongside the binary in the mirror layout.
step('Copying client/dist alongside');
fs.cpSync(clientDist, path.join(OUT, 'client', 'dist'), { recursive: true });

// 6. Done.
const size = (fs.statSync(BIN).size / (1024 * 1024)).toFixed(0);
const rel = path.relative(ROOT, BIN);
console.log(`\n==> Done. ${rel} (${size} MB)`);
console.log(`
Package layout (ship the whole dist/ya-namp/ folder):
  dist/ya-namp/
    server/dist/${path.basename(BIN)}
    client/dist/…

Run it (demo mode, works from any cwd):
  ${isWin ? 'dist\\ya-namp\\server\\dist\\ya-namp.exe' : './dist/ya-namp/server/dist/ya-namp'}

Real Yandex account:
  ${isWin ? 'set YANDEX_TOKEN=... &&' : 'YANDEX_TOKEN=...'} ${isWin ? 'dist\\ya-namp\\server\\dist\\ya-namp.exe' : './dist/ya-namp/server/dist/ya-namp'}
  (or drop a .env with YANDEX_TOKEN=... at dist/ya-namp/.env)

Then open http://localhost:8058  (override with PORT=...).

NOTE: SEA binaries are platform-specific — this one targets ${os.platform()}/${os.arch()}.
For a cross-compiled / single-FILE binary, see docs/single-binary.md (Bun path).
`);
