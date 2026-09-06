import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type FileSpec = string | { path: string; content: string };

export async function makeTempRepo(files: FileSpec[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archi-test-'));
  for (const spec of files) {
    const f = typeof spec === 'string' ? { path: spec, content: '' } : spec;
    const full = path.join(root, f.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.content, 'utf8');
  }
  return root;
}

export async function rmTemp(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

export function fileMap(root: string, files: FileSpec[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const spec of files) {
    const f = typeof spec === 'string' ? spec : spec.path;
    m.set(f, typeof spec === 'string' ? '' : spec.content);
  }
  return m;
}
