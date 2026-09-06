import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LspClient } from './lsp.js';
import { resolveGopls } from './goplsResolver.js';
import type { GraphStore, Sym } from './store.js';

const LSP_TIMEOUT_MS = 120_000;
const MAX_REFERENCE_SYMBOLS = 600;

interface LspPos {
  line: number;
  character: number;
}
interface LspSymbol {
  name: string;
  kind: number;
  range: { start: LspPos; end: LspPos };
  selectionRange: { start: LspPos };
  children?: LspSymbol[];
}
interface InternalSym {
  id: string;
  uri: string;
  start: LspPos;
  end: LspPos;
}

function toRel(root: string, absOrUri: string): string | null {
  let p = absOrUri;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(absOrUri);
    } catch {
      return null;
    }
  }
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  const norm = p.replace(/\\/g, '/');
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  return norm.startsWith(rootNorm) ? norm.slice(rootNorm.length) : null;
}

function cmpPos(a: LspPos, b: LspPos): number {
  return a.line - b.line || a.character - b.character;
}

/** Extract Go import paths from source. */
export function goImports(text: string): string[] {
  const out: string[] = [];
  // Single-line imports: import "pkg" or import "pkg1" "pkg2"
  for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
    out.push(m[1]);
  }
  // Block imports: import ( "pkg1" \n "pkg2" )
  for (const m of text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const line of m[1].split('\n')) {
      const q = line.match(/"([^"]+)"/);
      if (q) out.push(q[1]);
    }
  }
  return out;
}

/** Check if an import path is a Go standard library package. */
function isStdlib(pkg: string): boolean {
  // Heuristic: stdlib packages have no dots in the first path segment
  const first = pkg.split('/')[0];
  return !first.includes('.') && !first.includes('goversion');
}

/** Resolve a Go import path to a repo-relative .go file, if it maps into the repo. */
function resolveGoImport(
  root: string,
  importPath: string,
  goSet: Set<string>,
  modulePath: string
): string | null {
  // Relative import (./something)
  if (importPath.startsWith('.')) return null;

  // If the import path starts with the go.mod module path, it's internal
  if (modulePath && importPath.startsWith(modulePath)) {
    const rel = importPath.slice(modulePath.length).replace(/^\//, '');
    // Try directory with any .go file, or direct file
    for (const f of goSet) {
      if (f === rel || f.startsWith(rel + '/') || f.startsWith(rel + '\\')) return f;
    }
    // Try as package (directory with .go files)
    for (const f of goSet) {
      const dir = f.substring(0, f.lastIndexOf('/'));
      if (dir === rel) return f;
    }
  }

  return null;
}

function kindOf(lspKind: number, _parent: InternalSym | null, _hasChildren: boolean): 'function' | 'method' | null {
  // Go: no classes. Functions = kind 12, Methods = kind 6
  if (lspKind === 12) return 'function';
  if (lspKind === 6) return 'method'; // Go methods are always methods (receiver-based)
  return null;
}

/** Detect the go.mod module path for this repo. */
function detectModulePath(root: string, files: string[]): string {
  const goMod = files.find(f => f === 'go.mod');
  if (!goMod) return '';
  try {
    const text = fs.readFileSync(path.join(root, goMod), 'utf8');
    const m = text.match(/^module\s+(\S+)/m);
    return m?.[1] ?? '';
  } catch {
    return '';
  }
}

export async function indexGo(
  root: string,
  goFiles: string[],
  store: GraphStore
): Promise<{ symbols: number; calls: number; imports: number }> {
  if (goFiles.length === 0) return { symbols: 0, calls: 0, imports: 0 };

  // Resolve gopls: prefer bundled binary, fall back to PATH
  const resolved = resolveGopls();
  const goplsBin = resolved.command;
  const goplsArgs = resolved.args;
  const fromBundled = resolved.source === 'bundled';

  const goSet = new Set(goFiles);
  const modulePath = detectModulePath(root, goFiles);
  const texts = new Map<string, string>();
  for (const rel of goFiles) {
    try {
      texts.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
    } catch {
      /* unreadable - skip */
    }
  }
  const openable = [...texts.keys()];
  if (openable.length === 0) return { symbols: 0, calls: 0, imports: 0 };

  const client = new LspClient(goplsBin, goplsArgs, root);
  void fromBundled;

  const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`go index timed out: ${label}`)), LSP_TIMEOUT_MS)),
    ]);

  try {
    await withTimeout(
      client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: {
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
        initializationOptions: {},
      }),
      'initialize'
    );
    client.notify('initialized', {});

    // ---------- open files + symbols ----------
    const symbolsByUri = new Map<string, InternalSym[]>();
    let symbolCount = 0;

    for (const rel of openable) {
      const uri = pathToFileURL(path.join(root, rel)).href;
      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'go', version: 1, text: texts.get(rel)! },
      });
    }

    for (const rel of openable) {
      const uri = pathToFileURL(path.join(root, rel)).href;
      const root_syms: LspSymbol[] = await withTimeout(
        client.request('textDocument/documentSymbol', { textDocument: { uri } }, 20_000),
        `documentSymbol ${rel}`
      );
      if (!Array.isArray(root_syms)) continue;
      const internal: InternalSym[] = [];

      const walk = (nodes: LspSymbol[], parent: InternalSym | null, qPrefix: string) => {
        for (const n of nodes) {
          if (!n.range || !n.selectionRange) continue;
          const kind = kindOf(n.kind, parent, Array.isArray(n.children) && n.children.length > 0);
          let created: InternalSym | null = null;
          if (kind) {
            const qname = qPrefix ? `${qPrefix}.${n.name}` : n.name;
            const id = `${rel}:gosym:${qname}`;
            const sym: Sym = {
              id,
              kind,
              name: n.name,
              fileId: rel,
              startLine: n.range.start.line + 1,
              endLine: n.range.end.line + 1,
              signature: `${qname}()`,
              parent: parent?.id,
            };
            store.addSymbol(sym);
            store.addEdge(rel, id, 'contains');
            if (parent) store.addEdge(parent.id, id, 'contains');
            created = { id, uri, start: n.selectionRange.start, end: n.range.end };
            internal.push(created);
            symbolCount++;
          }
          if (n.children) walk(n.children, created ?? parent, created ? `${qPrefix}${qPrefix ? '.' : ''}${n.name}` : qPrefix);
        }
      };
      walk(root_syms, null, '');
      symbolsByUri.set(rel, internal);
    }

    // ---------- imports (regex + resolution) ----------
    let importCount = 0;
    for (const rel of openable) {
      const text = texts.get(rel)!;
      for (const imp of goImports(text)) {
        const target = resolveGoImport(root, imp, goSet, modulePath);
        if (target && target !== rel) {
          store.addEdge(rel, target, 'imports');
          importCount++;
        } else if (!isStdlib(imp) && !imp.startsWith('.')) {
          // External dependency
          const pkgRoot = imp.split('/').slice(0, 3).join('/');
          store.addExternal(pkgRoot, rel);
        }
      }
    }

    // ---------- calls via references ----------
    let callCount = 0;
    const refTargets: InternalSym[] = [];
    for (const list of symbolsByUri.values()) {
      for (const s of list) {
        const sym = store.getSymbol(s.id);
        if (sym && (sym.kind === 'function' || sym.kind === 'method')) refTargets.push(s);
      }
    }
    const capped = refTargets.slice(0, MAX_REFERENCE_SYMBOLS);

    for (const target of capped) {
      let locations: { uri: string; range: { start: LspPos } }[] | null = null;
      try {
        locations = await withTimeout(
          client.request('textDocument/references', {
            textDocument: { uri: target.uri },
            position: target.start,
            context: { includeDeclaration: false },
          }, 15_000),
          'references'
        );
      } catch {
        continue;
      }
      if (!Array.isArray(locations)) continue;

      for (const loc of locations) {
        const rel = toRel(root, loc.uri);
        if (!rel) continue;
        const list = symbolsByUri.get(rel);
        if (!list || list.length === 0) continue;
        let best: InternalSym | null = null;
        for (const s of list) {
          if (cmpPos(loc.range.start, s.start) >= 0 && cmpPos(loc.range.start, s.end) <= 0) {
            if (!best || cmpPos(s.start, best.start) >= 0) best = s;
          }
        }
        if (best && best.id !== target.id) {
          const before = store.edges.length;
          store.addEdge(best.id, target.id, 'calls');
          if (store.edges.length > before) callCount++;
        }
      }
    }

    await client.shutdown();
    return { symbols: symbolCount, calls: callCount, imports: importCount };
  } catch (e) {
    client.kill();
    throw e;
  }
}
