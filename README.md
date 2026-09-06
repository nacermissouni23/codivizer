# Archivizer

Local-first, deterministic code architecture explorer. Everything runs on your machine. Optional AI adds human-readable labels — your code never leaves the device, only an anonymous graph summary is sent for labeling.

![Archivizer - Repository to architecture map](assets/components.png)

```bash
npx archivizer /path/to/your/project
```

Then open **http://127.0.0.1:4840** (opens automatically).

---

## Zero prerequisites

Archivizer works out of the box on any new PC — Windows, macOS, or Linux — with just Node.js 20+:

- **Pyright** (Python) is bundled as pure JS — no Python install required.
- **gopls** (Go) is vendored for win32-x64, linux-x64, darwin-x64, darwin-arm64 — no Go install required (falls back to `gopls` on PATH if you have it).
- **Tree-sitter WASMs** are bundled (~36 grammars) — no compilation needed.
- **Frontend** is prebuilt (Vite + React + Mermaid).

```bash
npx archivizer ~/code/my-project
# works immediately on Windows, macOS, Linux (x64 + arm64)
```

---

## What it does

```text
npx archivizer <folder>
   ↓
localhost web app
   ↓
Index codebase (multiple engines, see below)
   ↓
Deterministic code graph
   ↓
Interactive explorer:  graph + tree side by side
   ↓
Drill down:  Repository → Folder → File → Class → Function → source code
```

- Click any node to see its **callers**, **callees**, and definition location.
- Click a file in the tree to see its symbols and read-only source.
- `Ctrl+K` searches symbol names and full-text code.
- File watcher is **ON by default** — edits trigger auto-reindex within ~500 ms. Pass `--no-watch` to disable.

---

## Supported languages

Archivizer uses **four indexing engines** to cover 30+ languages:

| Engine | Languages | Indexing quality |
|--------|-----------|-----------------|
| **TS LanguageService** | TypeScript, JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`) | Full — symbols, imports, type-checked call edges, env vars, route detection |
| **Pyright LSP** | Python (`.py`) | Full — symbols, imports, type-checked call edges |
| **Gopls LSP** | Go (`.go`) | Full — symbols, imports, call edges |
| **Tree-sitter WASM** | C, C++, C#, Rust, Ruby, PHP, Kotlin, Swift, Java, Dart, Elixir, Elm, Lua, Objective-C, OCaml, Scala, Zig, Bash, Solidity, ReScript, YAML, TOML, JSON, CSS, HTML, Vue, QL, SystemRDL, TLA+, Emacs Lisp, Embedded Templates, and more (36 WASMs bundled) | AST-based — symbols, imports, call edges |

**Manifest parsers** also detect dependencies from: `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`, `Cargo.toml`, `composer.json`, `Gemfile`, `*.csproj`, `Directory.Packages.props`, `vcpkg.json`, `conanfile.txt`, `deno.json`, `import_map.json`, `mix.exs`, `*.rockspec`.

> If the source code says it, Archivizer knows it. If Archivizer doesn't know it, it doesn't invent it.

---

## The six levels of understanding

Archivizer indexes your code once and derives six progressive views:

| Level | View | What it shows |
|-------|------|---------------|
| **L0** | Repository Brief | One-paragraph summary + key files |
| **L1** | System Context | External dependencies, env vars, confidence ratings |
| **L2** | Component Overview | Folder structure, language breakdown, symbol counts |
| **L3** | Dependencies | Import graph — who depends on whom |
| **L4** | Execution Trace | Entry points, call chains, route flows |
| **L5** | Symbol Inspector | Click any symbol — callers, callees, definition |

---

## AI annotations (optional)

```bash
# add your Gemini key once (stored in ~/.archi/config.json)
# get a key at https://aistudio.google.com/app/apikey
ARCHI_AI_KEY=AIza... Archivizer /path/to/project
# or set it in .env / ~/.archi/config.json via the Settings UI
```

One merged AI call per indexing (~5k chars) annotates all three views: Component Overview, System Context, and Repository Brief. If the key is missing or invalid, Archivizer works fully with deterministic plain labels. Badges show `AI annotating…` → `AI annotated` or `AI failed: <reason>` (hover for details). Only Google AI Studio API keys are supported for now.

**Privacy:** Archivizer builds the graph locally. Only the graph summary (folder names, top symbols, system kinds — no file contents) is sent to Google for labeling. See Settings for details.

---

## CLI options

```text
Archivizer [path]         folder to index immediately
Archivizer --port 5000    custom port (default 4840)
Archivizer --no-open      don't auto-open the browser
Archivizer --no-watch     disable filesystem watch (watch is ON by default)
Archivizer --watch        enable watch (default)
Archivizer --include-hidden  include dotfiles
Archivizer --version      print version
# archi works too as an alias
```

You can also start without a path (`npx archivizer`) and paste one into the UI.

---

## Architecture

```text
CLI (bin/archi.js)
  └── Fastify server (src/server.ts)
        ├── Indexers
        │     ├── FileWalker - walks files, respects .gitignore (via `ignore`), skips node_modules/.git/etc, detects encoding/BOM, 20 MB cap, symlink cycle guard
        │     ├── TsIndexer - TypeScript/JavaScript (TS LanguageService, honors tsconfig.json#exclude)
        │     ├── PyEngine - Python (pyright LSP over JSON-RPC)
        │     ├── GoEngine - Go (vendored gopls LSP)
        │     └── TreeSitterEngine - 36 languages (web-tree-sitter WASM, parallel via p-limit)
        ├── Manifests - parses package.json, requirements.txt, pyproject.toml (via @iarna/toml), go.mod, pom.xml (via fast-xml-parser), etc.
        ├── GraphStore - in-memory graph (nodes + edges), callersOf/calleesOf queries
        ├── Context - SYSTEM_SIGNATURES for 50+ frameworks/libraries
        ├── REST API (/api/repos/:id/...)
        └── Static React app (Vite + React + Mermaid + custom pan/zoom)
```

Key design decisions:

- **In-memory only** — no database, no persistence. Re-index on demand (or via watch).
- **Zero network calls** — everything runs locally. No telemetry.
- **Deterministic** — same code + same engine = same graph, every time.
- **Confidence-rated** — HIGH = imported in indexed code; MED = env-var-only or manifest-declared-only.
- **Zero prerequisites** — bundled pyright, vendored gopls, bundled WASMs.

---

## Limits

- **File size cap:** 20 MB per file. Larger files are included in the tree but skipped for symbol extraction (prevents OOM on generated files).
- **Binary files:** Detected via extension allowlist + null-byte sniff; appear in tree but not parsed.
- **Encoding:** BOM-aware (UTF-8, UTF-16 LE/BE). Non-UTF-8 files fall back to UTF-8 with replacement chars.
- **Symlink cycles:** Detected via realpath visited set; symlinks are not followed by default.
- **Trace depth:** Capped at 50 steps; results include `truncated: true` when exceeded.
- **Storage caps:** 5 000 symbols per file, 200 000 edges total (oldest edges dropped with warning).

---

## Platform support

| OS | Arch | Status |
|----|------|--------|
| Windows 10/11 | x64 | ✅ Tested (bundled gopls, `open` package) |
| macOS 13/14 | x64, arm64 | ✅ Tested (bundled gopls, `open` package) |
| Ubuntu 22.04 / Debian 12 | x64 | ✅ Tested (bundled gopls, xdg-open) |
| Linux arm64 | arm64 | ⚠️ Works if `gopls` on PATH (no bundled arm64 Linux binary yet) |

---

## Project structure

```text
archi/
  bin/archi.js           CLI entry point
  src/
    cli.ts               CLI argument parsing
    server.ts            Fastify server, routes, reindex pipeline, watch
    types.ts             Shared types
    walk.ts              File walker (ignore, encoding, binary, 20 MB cap)
    index/
      tsIndexer.ts       TypeScript/JavaScript indexer
      pyEngine.ts        Python LSP engine (pyright)
      goEngine.ts        Go LSP engine (bundled gopls)
      goplsResolver.ts   Cross-platform gopls resolution
      lsp.ts             Generic LSP client (JSON-RPC over stdio)
      treeSitterEngine.ts Tree-sitter WASM engine (36 languages, parallel)
      manifests.ts       Manifest parsers (15+ formats, real TOML/XML)
      store.ts           GraphStore - in-memory graph
      context.ts         SYSTEM_SIGNATURES, LABEL_OVERRIDES, matchSystemKind()
      brief.ts           L0: repository brief generation
      narrative.ts       L1: system context narrative
      overview.ts        L2: component overview
      trace.ts           L4: execution trace (depth-capped)
  web/
    src/
      App.tsx            Main app layout
      Sidebar.tsx        File tree + search
      Inspector.tsx      Symbol inspector (L5)
      DepsView.tsx       Dependency graph (L3)
      TraceView.tsx      Execution trace (L4)
      TracePickerView.tsx Trace entry point picker
      CodeView.tsx       Read-only source viewer
      components/
        BriefView.tsx    L0: repository brief
        ContextView.tsx  L1: system context
        OverviewView.tsx L2: component overview
        SettingsModal.tsx Settings UI
  scripts/
    fetch-gopls.mjs      Maintainer script to vendor gopls binaries
  tests/
    walk.test.ts         Walker tests
    cli.test.ts          CLI tests
    manifests.test.ts    Manifest parser tests
    trace.test.ts        Trace tests
    goplsResolver.test.ts Gopls resolver tests
```

---

## Development

```bash
# install deps
npm install
cd web && npm install && cd ..

# build everything (server + frontend)
npm run build

# start the server
npm start

# or run in dev mode (hot reload)
npm run dev

# frontend dev server (proxies /api to backend)
cd web && npm run dev

# run tests
npm test

# fetch gopls binaries for release (maintainer)
RELEASE_BUILD=1 npm run fetch-gopls -- --force
```

---

## What's next

- More languages and framework signatures
- Export (PNG/SVG, JSON graph)
- See `CHANGELOG.md` and [GitHub Discussions](https://github.com/nacermissouni23/archivizer/discussions)

---

## Contributing

Archivizer is open source (MIT). Contributions welcome.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `npm test && npm run build` to verify
5. Open a PR

**Adding a new language:**

1. Add a tree-sitter grammar to `src/index/treeSitterEngine.ts`:
   - Add a `LANGUAGES` entry with `symbolTypes`, `importType`, `callTypes`, `kindFromNode`
   - Add file extension mappings to `EXT_LANG`
2. If the language has popular frameworks, add entries to `SYSTEM_SIGNATURES` in `src/index/context.ts`
3. Add a fixture in `tests/fixtures/` and a test.
4. Test against a real project in that language

**Adding a manifest format:**

Add a parser in `src/index/manifests.ts` and register it in `ROOT_MANIFEST_PARSERS` or `GLOB_PARSERS`.

**Adding framework awareness:**

Add entries to `SYSTEM_SIGNATURES` in `src/index/context.ts`. Each entry maps a package name to its known symbols (classes, functions, constants). This enables Archivizer to recognize framework calls even when the framework source isn't indexed.

---

## License

MIT
