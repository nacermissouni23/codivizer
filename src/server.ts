import { promises as fs, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import * as os from 'node:os';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkDir, MAX_FILE_SIZE_BYTES, isBinaryExt } from './walk.js';
import { parseArgs, printHelp, printVersion } from './cli.js';
import { GraphStore } from './index/store.js';
import { indexRepo } from './index/tsIndexer.js';
import { buildOverview, type OverviewData } from './index/overview.js';
import { buildContext, type ContextData } from './index/context.js';
import { buildBrief } from './index/brief.js';
import { buildStory, type StoryData } from './index/narrative.js';
import { annotateAll } from './index/ai.js';
import { loadManifests } from './index/manifests.js';
import { indexPython } from './index/pyEngine.js';
import { indexGo } from './index/goEngine.js';
import { indexTreeSitter, getTreeSitterLang } from './index/treeSitterEngine.js';
import { traceCallChain, findEntryPoints, MAX_TRACE_DEPTH } from './index/trace.js';
import type { TreeNode } from './types.js';

// minimal .env loader (no dependency): fills process.env without overriding existing
function loadDotEnv() {
  try {
    const raw = readFileSync('.env', 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env - fine */
  }
}

function flatten(tree: TreeNode, out: string[] = []): string[] {
  for (const c of tree.children ?? []) {
    if (c.type === 'file') out.push(c.path);
    else flatten(c, out);
  }
  return out;
}

const store = new GraphStore();

async function fingerprint(target: string): Promise<string> {
  const tree = await walkDir(target);
  const files = flatten(tree);
  const parts: string[] = [];
  for (const rel of files) {
    try {
      const st = await fs.stat(path.join(target, rel));
      parts.push(`${rel}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${rel}:gone`);
    }
  }
  return parts.join('|');
}

let indexedFingerprint = '';

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.help) { printHelp(); return; }
  if (parsed.version) { printVersion(); return; }

  loadDotEnv();

  const target = parsed.target;
  let port = parsed.port;
  const openBrowser = parsed.open;
  const watchEnabled = parsed.watch;
  const includeHidden = parsed.includeHidden;

  // Validate target
  try {
    const st = await fs.stat(target);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`Codivizer: "${target}" is not a readable folder.`);
    process.exit(1);
  }

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.addHook('onSend', async (_req, reply) => {
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self';"
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  await app.register(fastifyRateLimit, {
    global: false,
  });
  const rootName = path.basename(target);

  // ---- AI key management (env > ~/.archi/config.json) ----
  const configPath = path.join(os.homedir(), '.archi', 'config.json');
  let aiKey: string | undefined = process.env.ARCHI_AI_KEY;

  function loadKeyFromConfig() {
    if (aiKey) return;
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (typeof cfg.ARCHI_AI_KEY === 'string' && cfg.ARCHI_AI_KEY) aiKey = cfg.ARCHI_AI_KEY;
    } catch {
      /* no config - fine */
    }
  }
  loadKeyFromConfig();
  const getApiKey = () => aiKey;

  function persistKey(key: string | null) {
    aiKey = key ?? undefined;
    try {
      if (key) {
        mkdirSync(path.dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ ARCHI_AI_KEY: key }, null, 2), 'utf8');
        // best-effort permission tightening
        if (process.platform !== 'win32') {
          try { chmodSync(configPath, 0o600); } catch { /* ignore */ }
        }
      } else {
        rmSync(configPath, { force: true });
      }
    } catch (e) {
      console.warn('  config: could not persist key -', String(e));
    }
  }

  app.get('/api/ai/status', async () => ({ hasKey: Boolean(getApiKey()) }));

  app.post('/api/ai/key', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const key = String((req.body as any)?.key ?? '').trim();
    if (!key) return reply.code(400).send({ error: 'missing key' });
    persistKey(key);
    if (overview) overview.ai = { pending: true, applied: false };
    if (contextData) contextData.ai = { pending: true, applied: false };
    if (storyData) storyData.ai = { pending: true, applied: false };
    if (overview && contextData && storyData) {
      aiPromise = runAiAll().then(() => { aiPromise = null; });
    }
    return { ok: true };
  });

  app.delete('/api/ai/key', async () => {
    persistKey(null);
    return { ok: true };
  });

  app.get('/api/repo', async () => ({ name: rootName }));

  app.get('/api/tree', async () => {
    const tree = await walkDir(target, { includeHidden });
    return tree;
  });

  // ---- AI: single merged call for overview + context + story (1 credit per indexing) ----
  let overview: OverviewData | null = null;
  let lastAnnotations: import('./index/overview.js').OverviewAnnotations | undefined;
  let contextData: ContextData | null = null;
  let lastContextAnnotations: import('./index/context.js').ContextAnnotations | undefined;
  let storyData: StoryData | null = null;
  let aiPromise: Promise<void> | null = null;

  function aiErrorMessage(e: unknown): string {
    const s = String(e);
    if (s.includes('API_KEY_INVALID') || s.includes('API key') || s.includes('PERMISSION_DENIED')) return 'Invalid API key';
    if (s.includes('NOT_FOUND') || s.includes('model not found') || s.includes('404')) return 'Model not found';
    if (s.includes('RESOURCE_EXHAUSTED') || s.includes('429') || s.includes('quota')) return 'Rate limited / quota exceeded';
    if (s.includes('AbortError') || s.includes('aborted')) return 'Request timed out';
    if (s.includes('empty annotations')) return 'AI returned empty annotations';
    if (s.length > 120) return s.slice(0, 120);
    return s;
  }

  async function runAiAll(attempt = 0) {
    const apiKey = getApiKey();
    if (!apiKey || !overview || !contextData || !storyData) return;
    const model = process.env.ARCHI_AI_MODEL || 'gemini-flash-lite-latest';
    try {
      const allowed = {
        files: new Set([...store.nodes.values()].filter((n) => n.type === 'file').map((n) => n.id)),
        components: new Set(storyData.skeleton.components.map((c) => c.id)),
        systems: new Set(storyData.skeleton.systems.map((s) => s.name)),
        actors: new Set(['cli', 'http', 'webhook', 'cron']),
      };
      const result = await annotateAll(overview, contextData, storyData.skeleton, allowed, apiKey, model);
      if (!result) throw new Error('AI returned empty result');
      const hasOv = Object.values(result.overview.components).some(v => v.label || v.description);
      if (!hasOv) throw new Error('AI returned empty annotations');
      lastAnnotations = result.overview;
      if (overview) { overview.annotations = result.overview; overview.ai = { pending: false, applied: true }; }
      lastContextAnnotations = result.context;
      if (contextData) { contextData.annotations = result.context; contextData.ai = { pending: false, applied: true }; }
      if (storyData && result.story.length > 0) { storyData.segments = result.story; storyData.ai = { pending: false, applied: true }; }
      else if (storyData) { storyData.ai = { pending: false, applied: false }; }
      console.log('  AI: all annotations applied (1 call)');
    } catch (e) {
      if (attempt < 1) {
        console.warn('  AI: pass failed, retrying once in 8s -', String(e));
        await new Promise(r => setTimeout(r, 8000));
        return runAiAll(attempt + 1);
      }
      if (overview) {
        const hasOv = Boolean(lastAnnotations && Object.values(lastAnnotations.components).some(v => v.label || v.description));
        if (hasOv) overview.annotations = lastAnnotations;
        overview.ai = { pending: false, applied: hasOv, error: hasOv ? undefined : aiErrorMessage(e) };
      }
      if (contextData) {
        if (lastContextAnnotations) contextData.annotations = lastContextAnnotations;
        const hasCtx = Boolean(lastContextAnnotations);
        contextData.ai = { pending: false, applied: hasCtx, error: hasCtx ? undefined : aiErrorMessage(e) };
      }
      if (storyData) storyData.ai = { pending: false, applied: false, error: aiErrorMessage(e) };
      console.warn('  AI: annotation failed, using cached/plain labels -', String(e));
    }
  }

  function rebuildOverview() {
    overview = buildOverview(store);
    const hasOv = Boolean(lastAnnotations && Object.values(lastAnnotations.components).some(v => v.label || v.description));
    if (hasOv) overview.annotations = lastAnnotations;
    const hasKey = Boolean(getApiKey());
    overview.ai = { pending: hasKey && !hasOv, applied: hasOv };
  }

  function rebuildContext() {
    contextData = buildContext(store, rootName, target);
    if (lastContextAnnotations) contextData.annotations = lastContextAnnotations;
    const hasKey = Boolean(getApiKey());
    const hasCtx = Boolean(lastContextAnnotations);
    contextData.ai = { pending: hasKey && !hasCtx, applied: hasCtx };
  }

  function rebuildStory() {
    storyData = buildStory(store, rootName, target, overview, contextData);
    const hasKey = Boolean(getApiKey());
    storyData.ai = { pending: hasKey, applied: false };
  }

  async function waitForAi() {
    if (aiPromise) await aiPromise;
  }

  // ---- reindex with race protection + storage caps ----
  const MAX_SYMBOLS_PER_FILE = 5_000;
  const MAX_EDGES = 200_000;
  type ReindexStats = ReturnType<GraphStore['stats']> & { truncated: boolean };
  let reindexPromise: Promise<ReindexStats> | null = null;

  function reindex() {
    if (reindexPromise) return reindexPromise;
    const p = (async () => {
      const tree = await walkDir(target, { includeHidden });
      const files = flatten(tree);
      store.clear();
      indexRepo(target, files, store);
      loadManifests(target, files, store);
      const pyFiles = files.filter((f) => f.endsWith('.py'));
      if (pyFiles.length > 0) {
        try {
          const py = await indexPython(target, pyFiles, store);
          console.log(`  python: ${JSON.stringify(py)}`);
        } catch (e) {
          console.warn(`  python engine skipped - ${String(e)}`);
        }
      }
      const goFiles = files.filter((f) => f.endsWith('.go'));
      let goSucceeded = false;
      if (goFiles.length > 0) {
        try {
          const go = await indexGo(target, goFiles, store);
          console.log(`  go: ${JSON.stringify(go)}`);
          goSucceeded = true;
        } catch (e) {
          console.warn(`  go engine skipped - ${String(e)}; falling back to tree-sitter for Go`);
        }
      }
      const treeSitterLangs = new Set<string>();
      const treeSitterFiles = files.filter((f) => {
        const lang = getTreeSitterLang(f);
        if (!lang) return false;
        if (lang === 'python' || lang === 'typescript' || lang === 'javascript') return false;
        if (lang === 'go' && goSucceeded) return false;
        treeSitterLangs.add(lang);
        return true;
      });
      if (treeSitterFiles.length > 0) {
        try {
          const ts = await indexTreeSitter(target, treeSitterFiles, store);
          console.log(`  tree-sitter[${[...treeSitterLangs].join(',')}]: ${JSON.stringify(ts)}`);
        } catch (e) {
          console.warn(`  tree-sitter engine skipped - ${String(e)}`);
        }
      }
      // Enforce storage caps
      let truncated = false;
      const beforeEdges = store.edges.length;
      if (beforeEdges > MAX_EDGES) {
        // Trim oldest surplus edges
        const surplus = store.edges.length - MAX_EDGES;
        store.edges.splice(0, surplus);
        truncated = true;
      }
      // Per-file symbol cap
      for (const [fileId, ids] of store.symbolsByFile) {
        if (ids.length > MAX_SYMBOLS_PER_FILE) {
          const surplusIds = ids.slice(MAX_SYMBOLS_PER_FILE);
          for (const id of surplusIds) store.nodes.delete(id);
          store.symbolsByFile.set(fileId, ids.slice(0, MAX_SYMBOLS_PER_FILE));
          truncated = true;
        }
      }
      indexedFingerprint = await fingerprint(target);
      rebuildOverview();
      rebuildContext();
      rebuildStory();
      if (getApiKey() && overview && contextData && storyData) {
        const needsAi = overview.ai.pending || contextData.ai.pending || storyData.ai.pending;
        if (needsAi) aiPromise = runAiAll().then(() => { aiPromise = null; });
      }
      const stats = store.stats();
      console.log(`  indexed: ${JSON.stringify(stats)}${truncated ? ' (truncated)' : ''}`);
      return { ...stats, truncated };
    })().finally(() => { reindexPromise = null; });
    reindexPromise = p;
    return p;
  }

  // SSE for index progress
  app.get('/api/index/progress', async (_req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });
    const send = (data: object) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ status: 'started', phase: 'walk' });
    try {
      const result = await reindex();
      send({ status: 'done', ...result });
    } catch (e) {
      send({ status: 'error', error: String(e) });
    }
    reply.raw.end();
    return reply;
  });

  // Initial reindex in background (don't block listen)
  const initialReindex = reindex();
  initialReindex.catch((e) => console.error('  initial index failed:', String(e)));

  app.get('/api/index/status', async () => {
    const ready = !reindexPromise;
    return { ready, indexing: !ready, ...store.stats() };
  });

  app.get('/api/overview', async () => {
    return overview ?? { components: [], edges: [], allFolders: [], ai: { pending: false, applied: false } };
  });

  app.get('/api/context', async () => {
    return contextData ?? { name: rootName, stats: store.stats(), internals: [], externals: [], ai: { pending: false, applied: false } };
  });

  app.get('/api/brief', async () => {
    return buildBrief(store, rootName, target, overview, contextData);
  });

  app.get('/api/story', async () => {
    return storyData ?? { segments: [], skeleton: {}, ai: { pending: false, applied: false } };
  });

  app.get('/api/index/fresh', async () => {
    if (!indexedFingerprint) return { fresh: true };
    try {
      const current = await fingerprint(target);
      return { fresh: current === indexedFingerprint };
    } catch {
      return { fresh: true };
    }
  });

  app.post('/api/index/refresh', {
    config: { rateLimit: { max: 1, timeWindow: '10 seconds' } },
  }, async (_req, reply) => {
    try {
      const result = await reindex();
      return { ok: true, ...result };
    } catch (e) {
      return reply.code(500).send({ error: String(e) });
    }
  });

  app.get('/api/symbols', async (req) => {
    const file = String((req.query as any).file ?? '');
    return { symbols: store.getSymbolsInFile(file) };
  });

  app.get('/api/symbol', async (req) => {
    const id = String((req.query as any).id ?? '');
    const sym = store.getSymbol(id);
    if (!sym) return { error: 'not found' };
    const nameOf = (edgeId: string) => store.getSymbol(edgeId)?.name ?? edgeId;
    const loc = (edgeId: string) => {
      const s = store.getSymbol(edgeId);
      return s ? `${s.fileId}:${s.startLine}` : '';
    };
    return {
      symbol: sym,
      callers: store
        .getCallers(sym.id)
        .filter((e) => e.type === 'calls')
        .map((e) => ({ id: e.src, name: nameOf(e.src), location: loc(e.src) })),
      callees: store
        .getCallees(sym.id)
        .filter((e) => e.type === 'calls')
        .map((e) => ({ id: e.dst, name: nameOf(e.dst), location: loc(e.dst) })),
    };
  });

  app.get('/api/deps', async (req) => {
    const file = String((req.query as any).file ?? '');
    const base = (id: string) => id.split('/').pop() ?? id;
    const dependencies = store
      .getCallees(file)
      .filter((e) => e.type === 'imports')
      .map((e) => ({ id: e.dst, name: base(e.dst) }));
    const dependents = store
      .getCallers(file)
      .filter((e) => e.type === 'imports')
      .map((e) => ({ id: e.src, name: base(e.src) }));
    return { file, dependencies, dependents };
  });

  app.get('/api/folderdeps', async (req) => {
    let dir = String((req.query as any).dir ?? '').replace(/\/+$/, '');
    if (dir === '(root)' || dir === '(root files)') dir = '';
    const base = (id: string) => id.split('/').pop() ?? id;
    const inDir = (f: string) =>
      dir === '' || f === dir || f.startsWith(dir + '/');

    const internal = [...store.nodes.values()]
      .filter((n) => n.type === 'file' && inDir(n.id))
      .map((n) => ({ id: n.id, name: base(n.id), comp: n.id.includes('/') ? n.id.split('/')[0] : '(root)' }));
    const internalIds = new Set(internal.map((f) => f.id));

    const nodeMap = new Map<string, { id: string; name: string; comp: string }>();
    for (const f of internal) nodeMap.set(f.id, f);

    const edgeMap = new Map<string, { src: string; dst: string; count: number; callsOnly: boolean }>();
    const hasImport = new Set<string>();
    const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
    const compOf = (f: string) => (f.includes('/') ? f.split('/')[0] : '(root)');

    const link = (srcFile: string, dstFile: string, viaCall: boolean) => {
      if (srcFile === dstFile) return;
      if (!internalIds.has(srcFile) && !internalIds.has(dstFile)) return;
      if (!viaCall) hasImport.add(pairKey(srcFile, dstFile));
      let e = edgeMap.get(pairKey(srcFile, dstFile));
      if (!e) {
        e = { src: srcFile, dst: dstFile, count: 0, callsOnly: true };
        edgeMap.set(pairKey(srcFile, dstFile), e);
      }
      e.count++;
    };

    for (const edge of store.edges) {
      if (edge.type === 'imports') {
        link(edge.src, edge.dst, false);
      } else if (edge.type === 'calls') {
        const sf = edge.src.slice(0, edge.src.indexOf(':'));
        const df = edge.dst.slice(0, edge.dst.indexOf(':'));
        link(sf, df, true);
      }
    }

    for (const e of edgeMap.values()) {
      for (const f of [e.src, e.dst]) {
        if (!nodeMap.has(f)) nodeMap.set(f, { id: f, name: base(f), comp: compOf(f) });
      }
    }
    for (const e of edgeMap.values()) {
      e.callsOnly = !hasImport.has(pairKey(e.src, e.dst));
    }

    return {
      dir,
      files: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    };
  });

  app.get('/api/search', async (req) => {
    const q = String((req.query as any).q ?? '');
    if (!q.trim()) return { results: [] };
    return { results: store.search(q, overview, contextData) };
  });

  app.get('/api/trace', async (req, reply) => {
    const id = String((req.query as any).id ?? '');
    if (!id || !id.includes(':')) {
      return reply.code(400).send({ error: 'invalid symbol id' });
    }
    const result = traceCallChain(store, id);
    if (!result) {
      return reply.code(404).send({ error: 'symbol not found' });
    }
    return result;
  });

  app.get('/api/entrypoints', async () => {
    return { entryPoints: findEntryPoints(store) };
  });

  app.get('/api/limits', async () => {
    return {
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      maxTraceDepth: MAX_TRACE_DEPTH,
      maxEdges: MAX_EDGES,
      maxSymbolsPerFile: MAX_SYMBOLS_PER_FILE,
      watching: watchEnabled,
    };
  });

  // Path-traversal-safe file read with size cap — now supports any text file (LICENSE, dotfiles, no-ext, etc.)
  app.get('/api/file', async (req, reply) => {
    const rel = String((req.query as any).path ?? '');
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      return reply.code(400).send({ error: 'invalid path' });
    }
    const base = rel.split('/').pop() ?? rel;
    if ([
      '.env', '.env.local', '.env.development', '.env.production',
      '.codivizerignore',
    ].includes(base) || /\.(pem|key|p12|pfx|gpg|asc)$/i.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) {
      return reply.code(400).send({ error: 'sensitive file' });
    }
    const abs = path.resolve(target, rel);
    const realRoot = await fs.realpath(target).catch(() => path.resolve(target));
    const realFile = await fs.realpath(abs).catch(() => abs);
    if (!realFile.startsWith(realRoot + path.sep) && realFile !== realRoot) {
      return reply.code(400).send({ error: 'path traversal blocked' });
    }
    try {
      const st = await fs.stat(realFile);
      if (!st.isFile() || st.size > MAX_FILE_SIZE_BYTES) {
        return reply.code(400).send({ error: 'not a readable file' });
      }
      const ext = path.extname(realFile).toLowerCase();
      if (isBinaryExt(ext)) {
        return reply.code(400).send({ error: 'binary file — preview not available' });
      }
      const buf = await fs.readFile(realFile);
      // NUL-byte sniff (binary detection) like walk.ts
      const sniffLen = Math.min(buf.length, 8192);
      let hasNul = false;
      for (let i = 0; i < sniffLen; i++) if (buf[i] === 0) { hasNul = true; break; }
      if (hasNul) {
        return reply.code(400).send({ error: 'binary file — preview not available' });
      }
      // BOM-aware decode (UTF-8 BOM, UTF-16 LE/BE)
      let content: string;
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        content = buf.subarray(3).toString('utf8');
      } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        const { default: iconv } = await import('iconv-lite');
        content = iconv.decode(buf.subarray(2), 'utf-16le');
      } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const { default: iconv } = await import('iconv-lite');
        content = iconv.decode(buf.subarray(2), 'utf-16be');
      } else {
        content = buf.toString('utf8');
      }
      return { path: rel, content };
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  // resolve the bundled frontend relative to this file (works from any cwd / global install)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.join(here, 'web');
  try {
    await fs.access(webDist);
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
  } catch {
    app.get('/', async (_req, reply) => {
      reply.type('text/html; charset=utf-8').send(
        '<body style="background:#10141b;color:#e8ebf1;font-family:monospace;padding:40px">Frontend assets missing in this install. Reinstall Codivizer, or run <code>npm run build</code> in the repo and use <code>npm start</code>.</body>'
      );
    });
  }

  // ---- listen: auto-fallback if the port is taken ----
  const MAX_PORT_TRIES = 10;
  let bound = 0;
  for (let attempt = 0; attempt < MAX_PORT_TRIES; attempt++) {
    const candidate = port + attempt;
    try {
      await app.listen({ port: candidate, host: '127.0.0.1' });
      bound = candidate;
      break;
    } catch (e: any) {
      if (e?.code !== 'EADDRINUSE') throw e;
      if (attempt === 0) console.log(`  port ${candidate} is busy, trying ${candidate + 1}…`);
    }
  }
  if (!bound) {
    console.error(`  Codivizer: ports ${port}–${port + MAX_PORT_TRIES - 1} are all busy. Pass --port <n>.`);
    process.exit(1);
  }
  port = bound;

  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Codivizer - indexing ${rootName}`);
  console.log(`  ${url}`);
  console.log(`  watch: ${watchEnabled ? 'ON' : 'OFF'}${includeHidden ? ' (hidden: included)' : ''}\n`);

  if (openBrowser) {
    // Use `open` package - works cross-platform without shell quoting bugs
    try {
      const { default: openP } = await import('open');
      await openP(url, { wait: false }).catch(() => {});
    } catch {
      /* user can navigate manually */
    }
  }

  // ---- filesystem watcher (Phase 2.6, default ON) ----
  if (watchEnabled) {
    try {
      const chokidar = await import('chokidar');
      const watcher = chokidar.watch(target, {
        ignored: (p: string) => {
          const base = path.basename(p);
          if (IGNORED_WATCH.has(base)) return true;
          // ignore hidden dirs except allowlist
          if (base.startsWith('.') && base !== '.' && !HIDDEN_WATCH_ALLOW.has(base)) return true;
          return false;
        },
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      });
      let debounce: NodeJS.Timeout | null = null;
      const trigger = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.log('  watch: change detected — press Refresh to reindex');
        }, 500);
      };
      watcher.on('add', trigger).on('change', trigger).on('unlink', trigger);
      const closeWatcher = () => { watcher.close().catch(() => {}); };
      process.on('SIGINT', closeWatcher);
      process.on('SIGTERM', closeWatcher);
    } catch (e) {
      console.warn(`  watch: failed to start - ${String(e)}`);
    }
  }
}

const IGNORED_WATCH = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  '.venv', 'venv', '__pycache__', 'site-packages',
  '.aws', '.ssh', '.gnupg', '.kube', '.docker', '.terraform',
]);
const HIDDEN_WATCH_ALLOW = new Set(['.github', '.vscode', '.editorconfig']);

main().catch((e) => {
  console.error('  Codivizer: fatal -', String(e));
  process.exit(1);
});
