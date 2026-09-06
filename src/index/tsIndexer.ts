import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import type { GraphStore, Sym } from './store.js';

const LANG_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

function scriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.mts': return ts.ScriptKind.TS;
    case '.cts': return ts.ScriptKind.TS;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

export function indexRepo(root: string, files: string[], store: GraphStore): void {
  store.clear();

  let langFiles = files.filter((f) => LANG_EXTS.has(path.extname(f).toLowerCase()));
  // Honor tsconfig.json#exclude if present
  try {
    const tsconfigRaw = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8');
    const tsconfig = JSON.parse(tsconfigRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    const exclude: string[] = tsconfig.exclude;
    if (Array.isArray(exclude) && exclude.length > 0) {
      const normExclude = exclude.map((p: string) => p.replace(/\/$/, ''));
      langFiles = langFiles.filter((f) => {
        for (const ex of normExclude) {
          if (f === ex || f.startsWith(ex + '/') || f.startsWith(ex.replace(/^\//, ''))) return false;
          // glob-like: dist/**, **/generated
          if (ex.includes('*')) {
            const re = new RegExp('^' + ex.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\//g, '\\/') + '($|\\/)');
            if (re.test(f)) return false;
          }
        }
        return true;
      });
    }
  } catch { /* no tsconfig or parse error */ }
  const sourceByFile = new Map<string, ts.SourceFile>();

  function toRel(abs: string): string {
    const norm = abs.replace(/\\/g, '/');
    const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    return norm.startsWith(rootNorm) ? norm.slice(rootNorm.length) : norm;
  }

  function loadSource(absPath: string): ts.SourceFile | undefined {
    const rel = toRel(absPath);
    const cached = sourceByFile.get(rel);
    if (cached) return cached;
    try {
      const st = fs.statSync(absPath);
      if (st.size > MAX_FILE_SIZE_BYTES) {
        console.warn(`  ts: skipping ${rel} (exceeds 20 MB)`);
        return undefined;
      }
      const text = fs.readFileSync(absPath, 'utf8');
      const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);
      sourceByFile.set(rel, sf);
      return sf;
    } catch {
      return undefined;
    }
  }

  for (const rel of langFiles) loadSource(path.join(root, rel));

  // ---------- evidence scan: env vars, routes, process.argv ----------
  const ENV_RE = [
    /\bprocess\.env\.([A-Z_][A-Z0-9_]*)/g,
    /\bprocess\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
    /\bos\.environ(?:\.get)?\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
    /\bos\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g,
    /\bos\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g,
  ];
  const ROUTE_RE = [
    /\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g,
    /@(Get|Post|Put|Delete|Patch)\(\s*['"]([^'"]*)['"]\s*\)/g,
  ];

  function scanEvidence(rel: string, text: string) {
    for (const re of ENV_RE) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        let set = store.envVars.get(m[1]);
        if (!set) {
          set = new Set();
          store.envVars.set(m[1], set);
        }
        set.add(rel);
      }
    }
    for (const re of ROUTE_RE) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const method = m[1].toUpperCase();
        const rPath = m[2];
        if (store.routes.length < 500) store.routes.push({ fileId: rel, method, path: rPath });
      }
    }
    if (/\bprocess\.argv\b/.test(text)) store.hasArgv = true;
  }

  for (const rel of langFiles) {
    const sf = sourceByFile.get(rel);
    if (sf) scanEvidence(rel, sf.getFullText());
  }


  const service = ts.createLanguageService(
    {
      getScriptFileNames: () => langFiles.map((f) => path.join(root, f)),
      getScriptVersion: () => '0',
      getScriptSnapshot: (fileName) => {
        const rel = toRel(fileName);
        const cached = sourceByFile.get(rel);
        if (cached) return ts.ScriptSnapshot.fromString(cached.getFullText());
        try {
          return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => ({
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        jsx: ts.JsxEmit.React,
        allowJs: true,
        esModuleInterop: true,
        skipLibCheck: true,
        strict: false,
      }),
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => fs.existsSync(f),
      readFile: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } },
      readDirectory: (p, exts, excl, incl, depth) =>
        ts.sys.readDirectory(p, exts, excl, incl, depth),
      getScriptKind: (fileName) => scriptKind(path.extname(fileName)),
      getNewLine: () => '\n',
    },
    ts.createDocumentRegistry()
  );

  const program = service.getProgram()!;
  const checker = program.getTypeChecker();

  // ---------- pass 1: symbols + contains + imports ----------
  const idCounter = new Map<string, number>();
  const defIndex = new Map<string, string>(); // `${fileId}:${line}:${name}` -> id

  function makeId(base: string): string {
    const n = (idCounter.get(base) ?? 0) + 1;
    idCounter.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  }

  function lineAt(sf: ts.SourceFile, pos: number): number {
    return sf.getLineAndCharacterOfPosition(pos).line + 1;
  }

  function fnSignature(node: ts.SignatureDeclaration): string {
    try {
      const sig = checker.getSignatureFromDeclaration(node);
      if (!sig) return node.name?.getText() ?? '';
      return `${node.name?.getText() ?? ''}(${sig.parameters
        .map((p) => p.getName())
        .join(', ')})`;
    } catch {
      return node.name?.getText() ?? '';
    }
  }

  function addSymbol(sym: Sym, parentId?: string): void {
    store.addSymbol(sym);
    defIndex.set(`${sym.fileId}:${sym.startLine}:${sym.name}`, sym.id);
    store.addEdge(sym.fileId, sym.id, 'contains');
    if (parentId) store.addEdge(parentId, sym.id, 'contains');
  }

  function collectSymbols(sf: ts.SourceFile, fileId: string): void {
    store.addFile(fileId);

    const visit = (node: ts.Node, parentId?: string): void => {
      let created: string | undefined;

      if (ts.isClassDeclaration(node) && node.name) {
        const id = makeId(`${fileId}:class:${node.name.text}`);
        addSymbol(
          {
            id,
            kind: 'class',
            name: node.name.text,
            fileId,
            startLine: lineAt(sf, node.getStart(sf)),
            endLine: lineAt(sf, node.getEnd()),
            signature: `class ${node.name.text}`,
          },
          parentId
        );
        created = id;
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        const id = makeId(`${fileId}:fn:${node.name.text}`);
        addSymbol(
          {
            id,
            kind: 'function',
            name: node.name.text,
            fileId,
            startLine: lineAt(sf, node.getStart(sf)),
            endLine: lineAt(sf, node.getEnd()),
            signature: fnSignature(node),
            async: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || undefined,
          },
          parentId
        );
        created = id;
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        const parentName = parentId ? store.getSymbol(parentId)?.name ?? '' : '';
        const name = node.name.text;
        const id = makeId(`${fileId}:method:${parentName}.${name}`);
        addSymbol(
          {
            id,
            kind: 'method',
            name,
            fileId,
            startLine: lineAt(sf, node.getStart(sf)),
            endLine: lineAt(sf, node.getEnd()),
            signature: fnSignature(node),
            parent: parentId,
            async: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || undefined,
          },
          parentId
        );
        created = id;
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const init = decl.initializer;
          if (!init || !(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
          const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (!isExported && parentId) continue; // only top-level or exported consts
          const name = decl.name.text;
          const id = makeId(`${fileId}:fn:${name}`);
          const isAsync = /(^|\s)async\s/.test(
            decl.getText(sf).slice(0, init.getStart(sf) - decl.getStart(sf))
          );
          addSymbol(
            {
              id,
              kind: 'function',
              name,
              fileId,
              startLine: lineAt(sf, node.getStart(sf)),
              endLine: lineAt(sf, node.getEnd()),
              signature: fnSignature(init as ts.FunctionLikeDeclaration),
              async: isAsync || undefined,
            },
            parentId
          );
        }
        return;
      }

      ts.forEachChild(node, (child) => visit(child, created ?? parentId));
    };

    ts.forEachChild(sf, (child) => visit(child));
  }

  for (const rel of langFiles) {
    const sf = sourceByFile.get(rel)!;
    collectSymbols(sf, rel);

    function recordExternal(modSpec: string): void {
      if (modSpec.startsWith('.') || modSpec.startsWith('/') || modSpec.startsWith('node:')) return;
      const pkgRoot = modSpec.startsWith('@')
        ? modSpec.split('/').slice(0, 2).join('/')
        : modSpec.split('/')[0];
      if (!pkgRoot || builtinModules.includes(pkgRoot)) return;
      store.addExternal(pkgRoot, rel);
    }

    for (const stmt of sf.statements) {
      const modSpec =
        ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)
          ? (stmt.moduleSpecifier as ts.StringLiteral | undefined)?.text
          : undefined;
      if (!modSpec) continue;
      const resolved = ts.resolveModuleName(modSpec, path.join(root, rel), {}, ts.sys)
        .resolvedModule;
      if (!resolved) {
        // bare specifier that couldn't resolve (no node_modules etc.) - still an external
        recordExternal(modSpec);
        continue;
      }
      const targetRel = toRel(resolved.resolvedFileName);
      if (langFiles.includes(targetRel)) {
        store.addEdge(rel, targetRel, 'imports');
      } else {
        // resolves outside the indexed set → third-party package
        recordExternal(modSpec);
      }
    }
  }

  // ---------- pass 2: call edges via definition lookup ----------
  // symbol ranges per file, innermost wins
  const rangesByFile = new Map<
    string,
    { id: string; start: number; end: number; len: number }[]
  >();
  for (const rel of langFiles) {
    const sf = sourceByFile.get(rel)!;
    const ranges = store.getSymbolsInFile(rel).map((s) => ({
      id: s.id,
      start: sf.getPositionOfLineAndCharacter(s.startLine - 1, 0),
      end: sf.getPositionOfLineAndCharacter(s.endLine - 1, 0),
      len: s.endLine - s.startLine,
    }));
    ranges.sort((a, b) => a.start - b.start);
    rangesByFile.set(rel, ranges);
  }

  function enclosingSymbol(fileId: string, absPath: string, pos: number): string | undefined {
    const sf = sourceByFile.get(fileId);
    if (!sf) return undefined;
    const ranges = rangesByFile.get(fileId);
    if (!ranges) return undefined;
    let best: { id: string; len: number } | undefined;
    for (const r of ranges) {
      if (pos >= r.start && pos <= r.end && r.len < (best?.len ?? Infinity)) {
        best = { id: r.id, len: r.len };
      }
    }
    return best?.id;
  }

  function findSymbolNear(fileId: string, fileName: string, pos: number): string | undefined {
    const sf =
      fileName === path.join(root, fileId)
        ? sourceByFile.get(fileId)
        : loadSource(fileName);
    if (!sf) return undefined;
    const cands = store.getSymbolsInFile(fileId);
    const hit = sf.getLineAndCharacterOfPosition(pos).line + 1;
    let best: Sym | undefined;
    let bestLen = Infinity;
    for (const s of cands) {
      if (hit >= s.startLine && hit <= s.endLine && s.endLine - s.startLine <= bestLen) {
        best = s;
        bestLen = s.endLine - s.startLine;
      }
    }
    return best?.id;
  }

  for (const rel of langFiles) {
    const absPath = path.join(root, rel);
    const sf = sourceByFile.get(rel)!;

    const visitCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const exprPos = node.expression.getStart(sf);
        const fromSym = enclosingSymbol(rel, absPath, exprPos);
        if (fromSym) {
          const defs = service.getDefinitionAtPosition(absPath, exprPos) ?? [];
          for (const d of defs) {
            const dFileId = toRel(d.fileName);
            if (!langFiles.includes(dFileId)) continue;
            const targetId = findSymbolNear(dFileId, d.fileName, d.textSpan.start);
            if (targetId && targetId !== fromSym) {
              store.addEdge(fromSym, targetId, 'calls');
            }
          }
        }
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(sf);
  }
}
