import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export interface GoplsResolveResult {
  command: string;
  args: string[];
  source: 'bundled' | 'path';
  warning?: string;
}

function bundledDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/index/goEngine.js -> dist/vendor/gopls
  return path.resolve(here, '..', 'vendor', 'gopls');
}

function platformKey(): string | null {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32' && a === 'x64') return 'win32-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  return null;
}

function exeName(p: string): string {
  return p === 'win32' ? 'gopls.exe' : 'gopls';
}

/**
 * Resolve the gopls binary. Order:
 *   1. Bundled binary in dist/vendor/gopls/<platformKey>/gopls[.exe]
 *      (chmod +x on POSIX on first use)
 *   2. `gopls` on PATH (developer override)
 * Throws if neither works.
 */
export function resolveGopls(): GoplsResolveResult {
  const key = platformKey();
  if (key) {
    const exe = exeName(process.platform);
    const bundled = path.join(bundledDir(), key, exe);
    if (fs.existsSync(bundled)) {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(bundled, 0o755); } catch { /* best effort */ }
      }
      return { command: bundled, args: [], source: 'bundled' };
    }
  }

  // Try PATH (developer override). No shell.
  try {
    const which =
      process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['gopls'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) {
      return { command: out, args: [], source: 'path' };
    }
  } catch {
    /* not on PATH */
  }

  throw new Error(
    `gopls binary not found. Bundled copy missing for ${process.platform}/${process.arch}, and no 'gopls' on PATH. ` +
    `Install with: go install golang.org/x/tools/gopls@latest`
  );
}

/**
 * Best-effort probe whether a binary is runnable. Used to fail fast with a clear message.
 */
export function probeRunnable(resolved: GoplsResolveResult): string | null {
  try {
    const out = execFileSync(resolved.command, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    if (!out || out.length < 2) {
      return `gopls returned empty -version output (${resolved.source})`;
    }
    return null;
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    return `gopls failed to start (${resolved.source}): ${msg}`;
  }
}
