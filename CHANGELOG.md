# Changelog

All notable changes to Codivizer.

## [0.2.1] - 2026-09-06
### Fixed
- **Crash on start**: `FST_ERR_PLUGIN_VERSION_MISMATCH` — `@fastify/rate-limit@10` requires fastify 5.x but Codivizer uses fastify 4.29.1. Downgraded to `@fastify/rate-limit@8.0.3` (fastify 4 compatible). `Codivizer` now starts on all OSes with zero prereqs.

## [0.2.0] - 2026-09-06

### Added
- **Zero-prerequisite install**: pyright bundled, gopls vendored for win32-x64/linux-x64/darwin-x64/darwin-arm64, tree-sitter WASMs bundled (~36 grammars). Works on any new PC with just Node 20+.
- **File watcher** (default ON): auto-reindex on filesystem changes via `chokidar` with 500 ms debounce. Pass `--no-watch` to disable. Toggle in Settings UI.
- **15+ manifest formats** with real parsers: `@iarna/toml` for `pyproject.toml`/`Cargo.toml`, `fast-xml-parser` for `pom.xml`, plus `vcpkg.json`, `conanfile.txt`, `deno.json`, `mix.exs`, `*.rockspec`, `Directory.Packages.props`, deep `composer.json` walk, monorepo workspace detection.
- **Real gitignore** via `ignore` package: globs, negations, CRLF, per-directory `.gitignore`, plus new `.codivizerignore`.
- **Encoding detection** via `iconv-lite`: BOM-aware (UTF-8, UTF-16 LE/BE), fallback to UTF-8.
- **Binary detection**: extension allowlist (~80 types) + null-byte sniff; binary files appear in tree but not parsed.
- **20 MB file size cap** per file; larger files included in tree but skipped for indexing.
- **Symlink cycle protection** via realpath visited set; symlinks not followed by default.
- **Cross-platform fixes**: `open` package for browser launch (fixes macOS/Linux `$url` bug), `goplsResolver` for bundled gopls (fixes Windows-only `where` bug), tilde expansion, `--version`/`--help`/`--path`/`--include-hidden` flags, strict `--port` validation.
- **Parallel tree-sitter parsing** via `p-limit` (concurrency = CPU cores).
- **Trace depth cap** (50 steps, `truncated: true`), storage caps (5 000 symbols/file, 200 000 edges), background indexing with SSE progress.
- **Security hardening**: path-traversal guard with realpath, body limits (64 KB), rate limiting, CSP tightening, sensitive file expansion, `chmod 600` for AI key.
- **Tests**: vitest suite (55+ tests) for walker, CLI, manifests, trace, goplsResolver.
- **Docs**: `CONTRIBUTING.md`, `docs/PERFORMANCE.md`, `docs/SECURITY.md`, platform support matrix, limits section, L5 in levels table.

### Fixed
- **Browser auto-open broken on macOS/Linux** (`server.ts:519-521` literal `$url` bug) — replaced shell string with `open` package.
- **gopls discovery broken on macOS/Linux** (`goEngine.ts:129` Windows-only `where`) — now prefers bundled binary, falls back to `which` + PATH.
- **Tree-sitter call resolution massive false positives** (substring hack) — now exact name match only.
- **`.gitignore` globs/negations ignored** — now real `ignore` library.
- **Missing `.mts`/`.cts`/`.jsx` handling** — added to both `tsIndexer` and `treeSitterEngine`.
- **Placeholder languages empty** (yaml/toml/json/css/html/vue/ql/systemrdl/tlaplus/elisp/embedded_template) — now real symbol/import/call definitions.
- **pom.xml groupId ignored** (collision) — now `groupId:artifactId`.
- **Cargo.toml dev/build dependencies ignored** — now parsed.
- **Gradle any-string match** — now filtered to dependency scopes only.
- **README inaccuracies**: removed false React Flow claim, fixed Mermaid stack, added L5, corrected language count, added zero-prereq and limits sections.
- **No symlink cycle protection** — now visited set.
- **No tests** — now 55+ vitest tests.
- **`truncated: false` hardcoded** — now properly sets truncated when depth exceeded.

### Changed
- Walker now respects `tsconfig.json#exclude`.
- Manifest loaders handle monorepo workspaces (nested `package.json`, `Cargo.toml`, `pom.xml`).
- Server starts immediately and indexes in background (was blocking `listen`).
- `walkDir` now takes `{ includeHidden }` option; hidden files use allowlist.

---

## [0.1.2] - 2026-08-27
### Fixed
- Bump `glob` to `^11.0.3` via overrides (fixes deprecated warning from `@fastify/static`)

## [0.1.1] - 2026-08-27
### Added
- Repository, homepage, bugs links for npm → GitHub package linking
- Keywords for npm discoverability

## [0.1.0] - 2026-08-27

### Added
- 5 progressive views: Repository Brief (L0), System Context (L1), Component Overview (L2), Dependencies (L3), Execution Trace (L4), Symbol Inspector (L5)
- 4 indexing engines covering 36 languages: TS LanguageService, Pyright LSP, Gopls LSP, Tree-sitter WASM
- Manifest parsers for 10+ formats (package.json, requirements.txt, pyproject.toml, go.mod, pom.xml, etc.)
- Global search (`Ctrl+K`) grouped by type + local diagram filter
- Optional AI annotations (single merged Gemini call per indexing) with truthful `AI annotated` / `AI failed` badges
- Settings UI for API key (stored in `~/.archi/config.json`)
- File tree, read-only code viewer, inspector with callers/callees

### Fixed
- Text overflow in Mermaid nodes, filter dim logic, tab titles, search→code navigation
