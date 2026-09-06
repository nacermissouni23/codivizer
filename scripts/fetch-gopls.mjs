#!/usr/bin/env node
/**
 * Fetch gopls binaries for all supported platforms.
 * Usage: node scripts/fetch-gopls.mjs
 * Requires: curl or wget available, or Node fetch (Node 18+).
 *
 * This is a maintainer script - not run on regular `npm install`.
 * Run with RELEASE_BUILD=1 during `npm run build` for releases,
 * or manually before publishing.
 *
 * gopls is BSD-3-Clause - see https://github.com/golang/tools/blob/master/LICENSE
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.GOPLS_VERSION || 'v0.16.2';
const REPO = 'https://github.com/golang/tools';
const outBase = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'vendor', 'gopls');

const targets = [
  { key: 'win32-x64', asset: `gopls-${VERSION}-windows-amd64.zip`, bin: 'gopls.exe' },
  { key: 'linux-x64', asset: `gopls-${VERSION}-linux-amd64`, bin: 'gopls' },
  { key: 'darwin-x64', asset: `gopls-${VERSION}-darwin-amd64`, bin: 'gopls' },
  { key: 'darwin-arm64', asset: `gopls-${VERSION}-darwin-arm64`, bin: 'gopls' },
];

async function fetchBinary(url, dest) {
  console.log(`  fetch ${url} -> ${dest}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // If zip, extract first entry (gopls.exe)
  if (url.endsWith('.zip')) {
    // Minimal zip extraction: find local file header for gopls.exe
    // For simplicity, use Node's built-in unzip via `unzip` if available, else warn
    const tmpZip = dest + '.tmp.zip';
    fs.writeFileSync(tmpZip, buf);
    try {
      const { execFileSync } = await import('node:child_process');
      // Try unzip (available on most systems) or PowerShell Expand-Archive on Windows
      if (process.platform === 'win32') {
        execFileSync('powershell', ['-Command', `Expand-Archive -Path "${tmpZip}" -DestinationPath "${path.dirname(dest)}" -Force`], { stdio: 'inherit' });
        // Find gopls.exe inside extracted dir
        const found = findGopls(path.dirname(dest));
        if (found && found !== dest) fs.renameSync(found, dest);
      } else {
        execFileSync('unzip', ['-o', tmpZip, '-d', path.dirname(dest)], { stdio: 'inherit' });
        const found = findGopls(path.dirname(dest));
        if (found && found !== dest) fs.renameSync(found, dest);
      }
    } finally {
      try { fs.unlinkSync(tmpZip); } catch {}
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf, { mode: 0o755 });
  }
  try { fs.chmodSync(dest, 0o755); } catch {}
}

function findGopls(dir) {
  const entries = fs.readdirSync(dir, { recursive: true });
  for (const e of entries) {
    const p = path.join(dir, String(e));
    if (path.basename(p) === 'gopls' || path.basename(p) === 'gopls.exe') return p;
  }
  return null;
}

async function main() {
  if (!process.env.RELEASE_BUILD && !process.argv.includes('--force')) {
    console.log('  fetch-gopls: skipping (set RELEASE_BUILD=1 or pass --force to fetch)');
    return;
  }
  console.log(`  fetch-gopls: version ${VERSION} -> ${outBase}`);
  fs.mkdirSync(outBase, { recursive: true });
  // Write LICENSE notice
  const licensePath = path.join(outBase, 'LICENSE');
  if (!fs.existsSync(licensePath)) {
    fs.writeFileSync(licensePath, `gopls - BSD-3-Clause\nSource: https://github.com/golang/tools\nVersion: ${VERSION}\nSee https://github.com/golang/tools/blob/master/LICENSE\n`);
  }
  const readmePath = path.join(outBase, 'README.md');
  fs.writeFileSync(readmePath, `# Vendored gopls\n\nVersion: ${VERSION}\nSource: ${REPO}/releases/tag/gopls/${VERSION}\nLicense: BSD-3-Clause\n\nBinaries are downloaded by \`scripts/fetch-gopls.mjs\` during release builds.\nNot committed to git - fetched on demand for publishing.\n`);

  for (const t of targets) {
    const url = `${REPO}/releases/download/gopls/${VERSION}/${t.asset}`;
    const dest = path.join(outBase, t.key, t.bin);
    if (fs.existsSync(dest) && !process.argv.includes('--force')) {
      console.log(`  exists: ${dest} (skip)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      await fetchBinary(url, dest);
      console.log(`  ok: ${dest}`);
    } catch (e) {
      console.warn(`  warn: failed to fetch ${t.key}: ${e.message}`);
      console.warn(`        URL: ${url}`);
      console.warn(`        On publish, ensure gopls binaries are available or build with --force after manual download.`);
    }
  }
  console.log('  fetch-gopls: done');
}

main().catch((e) => { console.error(e); process.exit(1); });
