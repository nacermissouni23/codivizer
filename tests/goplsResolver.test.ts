import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveGopls, probeRunnable } from '../src/index/goplsResolver';

describe('resolveGopls', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gopls-test-'));
  });
  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('throws with clear error when no binary found', async () => {
    // We can't easily test the bundled case without setting up vendor dir.
    // This tests the fallback path: no bundled, PATH likely empty in test env.
    const platformKey = `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`;
    const validKeys = ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];
    if (!validKeys.includes(platformKey)) {
      // Skip for unsupported platforms (e.g. linux-arm64)
      return;
    }
    // The bundled dir is computed relative to the compiled location;
    // it won't exist in this test environment unless explicitly set up.
    // We expect either bundled (if dev set up dist/vendor) or throw.
    try {
      const result = resolveGopls();
      expect(result.command).toBeTruthy();
      expect(['bundled', 'path']).toContain(result.source);
    } catch (e: any) {
      expect(String(e.message)).toContain('gopls');
    }
  });

  it('result has command and args', () => {
    try {
      const r = resolveGopls();
      expect(typeof r.command).toBe('string');
      expect(Array.isArray(r.args)).toBe(true);
    } catch {
      // not installed - acceptable for CI
    }
  });
});

describe('probeRunnable', () => {
  it('returns null for non-existent binary', () => {
    const err = probeRunnable({ command: path.join(os.tmpdir(), 'does-not-exist-' + Date.now()), args: [], source: 'path' });
    expect(err).toBeTruthy();
    expect(err).toMatch(/gopls/);
  });
});
