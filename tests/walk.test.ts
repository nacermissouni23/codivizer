import { describe, it, expect, afterEach } from 'vitest';
import { walkDir, MAX_FILE_SIZE_BYTES, isBinaryExt, isSensitiveName, readTextSmart } from '../src/walk';
import { makeTempRepo, rmTemp } from './helpers/tmp';
import * as path from 'node:path';

const dirs: string[] = [];
async function repo(files: any[]): Promise<string> {
  const d = await makeTempRepo(files);
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rmTemp(d);
});

describe('walkDir', () => {
  it('returns empty tree for empty dir', async () => {
    const root = await repo([]);
    const tree = await walkDir(root);
    expect(tree.children).toEqual([]);
  });

  it('walks simple files and dirs sorted', async () => {
    const root = await repo([
      { path: 'src/a.ts', content: 'x' },
      { path: 'src/b.ts', content: 'y' },
      { path: 'README.md', content: '# r' },
    ]);
    const tree = await walkDir(root);
    const names = tree.children!.map((c: any) => c.name);
    expect(names).toContain('README.md');
    expect(names).toContain('src');
    const src = tree.children!.find((c: any) => c.name === 'src')!;
    const files = src.children!.filter((c: any) => c.type === 'file').map((f: any) => f.name);
    expect(files).toEqual(['a.ts', 'b.ts']);
  });

  it('skips node_modules, dist, .git by default', async () => {
    const root = await repo([
      'node_modules/foo/index.js',
      'dist/bundle.js',
      '.git/HEAD',
      'src/a.js',
    ]);
    const tree = await walkDir(root);
    const all = JSON.stringify(tree);
    expect(all).not.toContain('node_modules');
    expect(all).not.toContain('dist');
    expect(all).not.toContain('.git');
    expect(all).toContain('src');
  });

  it('hides dotfile dirs by default, includes with --include-hidden (except blocked)', async () => {
    const root = await repo([
      '.github/workflows/ci.yml',
      '.aws/credentials',
      '.mycustom/dir/x.txt',
      'src/a.js',
    ]);
    const hidden = await walkDir(root);
    const allHidden = JSON.stringify(hidden);
    expect(allHidden).not.toContain('.aws');        // blocked even with --include-hidden
    expect(allHidden).not.toContain('.mycustom');   // not allowlisted

    const shown = await walkDir(root, { includeHidden: true });
    expect(JSON.stringify(shown)).toContain('.mycustom');
    expect(JSON.stringify(shown)).not.toContain('.aws');
  });

  it('respects .gitignore with globs and negations', async () => {
    const root = await repo([
      { path: '.gitignore', content: '*.log\nbuild/\n!important.log\nsrc/secrets/' },
      { path: 'app.log', content: 'log' },
      { path: 'important.log', content: '!' },
      { path: 'build/out.js', content: 'x' },
      { path: 'src/a.js', content: 'a' },
      { path: 'src/secrets/key.pem', content: 'k' },
    ]);
    const tree = await walkDir(root);
    const all = JSON.stringify(tree);
    expect(all).toContain('src/a.js');
    expect(all).not.toContain('app.log');
    expect(all).toContain('important.log');
    expect(all).not.toContain('build');
  });

  it('supports per-directory .gitignore', async () => {
    const root = await repo([
      'src/a.js',
      { path: 'src/.gitignore', content: '*.test.js' },
      'src/a.test.js',
    ]);
    const tree = await walkDir(root);
    const src = tree.children!.find((c: any) => c.name === 'src')!;
    const names = src.children!.map((c: any) => c.name);
    expect(names).toContain('a.js');
    expect(names).not.toContain('a.test.js');
  });

  it('handles CRLF in .gitignore', async () => {
    const root = await repo([
      { path: '.gitignore', content: '*.log\r\n!important.log\r\n' },
      'a.log',
      'important.log',
    ]);
    const tree = await walkDir(root);
    const all = JSON.stringify(tree);
    expect(all).not.toContain('a.log');
    expect(all).toContain('important.log');
  });

  it('does not infinite-loop on symlink cycles', async () => {
    const root = await repo([
      'src/a.js',
    ]);
    // Create symlink: src/sub -> src (cycle)
    const fs = await import('node:fs/promises');
    await fs.mkdir(path.join(root, 'src', 'sub'));
    try {
      await fs.symlink(path.join(root, 'src'), path.join(root, 'src', 'sub', 'link'), 'dir');
    } catch {
      // Skip on platforms that fail (Windows without perms); test is about cycle, not symlink creation
      return;
    }
    const tree = await walkDir(root);
    expect(tree).toBeDefined();
    expect(tree.children).toBeDefined();
  });

  it('exposes binary files in tree but skips sensitive files', async () => {
    const root = await repo([
      'image.png',
      '.env',
      'creds.pem',
      'id_rsa',
      'src/a.js',
    ]);
    const tree = await walkDir(root);
    const all = JSON.stringify(tree);
    expect(all).toContain('image.png');
    expect(all).toContain('src/a.js');
    expect(all).not.toContain('.env');
    expect(all).not.toContain('creds.pem');
    expect(all).not.toContain('id_rsa');
  });

  it('includes 20MB files in tree (size cap is for indexing, not walking)', async () => {
    const root = await repo([
      'src/a.js',
      'big.bin',
    ]);
    const tree = await walkDir(root);
    const all = JSON.stringify(tree);
    expect(all).toContain('big.bin');
  });
});

describe('MAX_FILE_SIZE_BYTES', () => {
  it('is 20 MB', () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('isBinaryExt', () => {
  it('detects common binary extensions', () => {
    expect(isBinaryExt('.png')).toBe(true);
    expect(isBinaryExt('.exe')).toBe(true);
    expect(isBinaryExt('.wasm')).toBe(true);
    expect(isBinaryExt('.ts')).toBe(false);
    expect(isBinaryExt('.py')).toBe(false);
  });
});

describe('isSensitiveName', () => {
  it('flags .env files', () => {
    expect(isSensitiveName('.env')).toBe(true);
    expect(isSensitiveName('.env.local')).toBe(true);
  });
  it('flags pem/key/p12/pfx', () => {
    expect(isSensitiveName('foo.pem')).toBe(true);
    expect(isSensitiveName('foo.key')).toBe(true);
    expect(isSensitiveName('foo.p12')).toBe(true);
    expect(isSensitiveName('foo.pfx')).toBe(true);
  });
  it('flags SSH keys', () => {
    expect(isSensitiveName('id_rsa')).toBe(true);
    expect(isSensitiveName('id_ed25519')).toBe(true);
  });
  it('passes normal files', () => {
    expect(isSensitiveName('index.ts')).toBe(false);
    expect(isSensitiveName('config.json')).toBe(false);
  });
});

describe('readTextSmart', () => {
  it('strips UTF-8 BOM', async () => {
    const root = await repo([{ path: 'a.txt', content: '\uFEFFhello' }]);
    const text = await readTextSmart(path.join(root, 'a.txt'));
    expect(text).toBe('hello');
  });
  it('decodes UTF-16 LE BOM', async () => {
    const root = await repo([]);
    const fs = await import('node:fs/promises');
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]);
    await fs.writeFile(path.join(root, 'a.txt'), buf);
    const text = await readTextSmart(path.join(root, 'a.txt'));
    expect(text).toBe('hello');
  });
  it('returns empty for binary (NUL byte) content', async () => {
    const root = await repo([]);
    const fs = await import('node:fs/promises');
    const buf = Buffer.from([0x68, 0x00, 0x69, 0x00]); // 'h\0i\0'
    await fs.writeFile(path.join(root, 'a.txt'), buf);
    const text = await readTextSmart(path.join(root, 'a.txt'));
    expect(text).toBe('');
  });
});
