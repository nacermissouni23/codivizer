import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import iconv from 'iconv-lite';
import type { TreeNode } from './types.js';

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.venv', 'venv', '__pycache__', 'site-packages',
  '.next', '.cache', 'coverage',
  '.aws', '.ssh', '.gnupg', '.kube', '.docker', '.terraform',
  '.chef', '.idea', '.vscode', '.mvn', '.gradle', '.terraform.d',
]);

const SENSITIVE_FILES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  '.archivizignore',
]);

const SENSITIVE_PATTERNS: RegExp[] = [
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
  /^id_rsa/, /^id_dsa/, /^id_ecdsa/, /^id_ed25519/,
  /credentials\.json$/i, /secrets?\.json$/i,
  /\.gpg$/i, /\.asc$/i,
];

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.heic',
  '.pdf',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.tgz',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.war',
  '.lock', '.parquet', '.sqlite', '.db', '.sqlite3',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flac', '.ogg', '.wav',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.psd', '.ai', '.sketch', '.fig',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
  '.pcap',
  '.pyc', '.pyo',
  '.wasm',
]);

const HIDDEN_ALLOWLIST = new Set([
  '.github', '.vscode', '.editorconfig', '.gitignore', '.gitattributes',
  '.archivizignore', '.eslintrc', '.prettierrc', '.npmrc',
]);

/** Detect encoding by BOM; return {encoding, bomSize} or null if ASCII/UTF-8. */
function detectEncoding(buf: Buffer): { encoding: string; stripBom: boolean } | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', stripBom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', stripBom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', stripBom: true };
  }
  return null;
}

/** Read a file with BOM-aware encoding detection. Falls back to UTF-8. */
export async function readTextSmart(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  const det = detectEncoding(buf);
  let body: Buffer = buf;
  if (det?.stripBom) {
    body =
      det.encoding === 'utf-8' ? buf.subarray(3) :
      det.encoding === 'utf-16le' ? buf.subarray(2) :
      det.encoding === 'utf-16be' ? buf.subarray(2) :
      buf;
  }
  if (det && det.encoding !== 'utf-8') {
    return iconv.decode(body, det.encoding);
  }
  // Heuristic: if first 8 KB contains a NUL byte, treat as binary.
  const sniffLen = Math.min(body.length, 8192);
  let hasNul = false;
  for (let i = 0; i < sniffLen; i++) if (body[i] === 0) { hasNul = true; break; }
  if (hasNul) {
    return '';
  }
  return body.toString('utf8');
}

export function isBinaryExt(ext: string): boolean {
  return BINARY_EXTS.has(ext.toLowerCase());
}

export function isSensitiveName(name: string): boolean {
  if (SENSITIVE_FILES.has(name)) return true;
  return SENSITIVE_PATTERNS.some((r) => r.test(name));
}

async function readGitignore(dir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
  } catch {
    return '';
  }
}

async function readArchivizignore(dir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(dir, '.archivizignore'), 'utf8');
  } catch {
    return '';
  }
}

export interface WalkOptions {
  includeHidden?: boolean;
}

export async function walkDir(root: string, opts: WalkOptions = {}): Promise<TreeNode> {
  const includeHidden = opts.includeHidden ?? false;
  const rootGitignore = ignore().add(await readGitignore(root));
  const rootArchiviz = ignore().add(await readArchivizignore(root));
  const visited = new Set<string>();

  async function walk(absDir: string, relPrefix: string, depth: number): Promise<TreeNode[]> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Cycle protection: track realpaths
    let real: string;
    try {
      real = await fs.realpath(absDir);
    } catch {
      real = absDir;
    }
    if (visited.has(real)) return [];
    visited.add(real);

    const localGitignore =
      depth === 0 ? rootGitignore : ignore().add(await readGitignore(absDir));
    const localArchiviz =
      depth === 0 ? rootArchiviz : ignore().add(await readArchivizignore(absDir));

    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      const name = entry.name;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const isHidden = name.startsWith('.');

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue;
        if (!includeHidden && isHidden && !HIDDEN_ALLOWLIST.has(name)) continue;
        if (localGitignore.ignores(rel) || localArchiviz.ignores(rel)) continue;
        const children = await walk(path.join(absDir, name), rel, depth + 1);
        if (children.length === 0) continue;
        nodes.push({ name, path: rel, type: 'dir', children });
      } else if (entry.isFile()) {
        if (isSensitiveName(name)) continue;
        if (!includeHidden && isHidden && !HIDDEN_ALLOWLIST.has(name)) continue;
        if (localGitignore.ignores(rel) || localArchiviz.ignores(rel)) continue;
        const ext = path.extname(name).toLowerCase();
        if (isBinaryExt(ext)) {
          // binary files still appear in tree as files (so UI can show them), no ext symbol extraction
          nodes.push({ name, path: rel, type: 'file', ext });
          continue;
        }
        try {
          const st = await fs.stat(path.join(absDir, name));
          if (st.size > MAX_FILE_SIZE_BYTES) {
            // include in tree but mark
            nodes.push({ name, path: rel, type: 'file', ext });
            continue;
          }
        } catch {
          /* ignore stat errors */
        }
        nodes.push({ name, path: rel, type: 'file', ext });
      } else if (entry.isSymbolicLink()) {
        // Don't follow symlinks by default - this prevents cycle loops
        // and matches user expectations for monorepos (workspaces are real dirs).
        // Users can opt in by creating a real junction.
        continue;
      }
    }

    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  const children = await walk(root, '', 0);
  const rootName = path.basename(path.resolve(root));
  return { name: rootName, path: '', type: 'dir', children };
}
