# Performance

## Tuning knobs

| Knob | Default | Where |
|------|---------|-------|
| `MAX_FILE_SIZE_BYTES` | 20 MB | `src/walk.ts`, `src/index/tsIndexer.ts`, `src/index/treeSitterEngine.ts` |
| `MAX_SYMBOLS_PER_FILE` | 5 000 | `src/server.ts` (reindex) |
| `MAX_EDGES` | 200 000 | `src/server.ts` |
| `MAX_TRACE_DEPTH` | 50 | `src/index/trace.ts` |
| Tree-sitter parallelism | `os.cpus().length` | `src/index/treeSitterEngine.ts` (p-limit) |
| Chokidar debounce | 500 ms | `src/server.ts` (watch) |
| LSP timeout | 120 s | `src/index/goEngine.ts`, `src/index/pyEngine.ts` |

## Scaling notes

- **Memory**: each file is read into memory once per indexer. Very large generated files (>20 MB) are skipped.
- **Tree-sitter**: parses in parallel up to CPU core count; per-file isolation ensures one bad file doesn't kill the run.
- **Manifests**: `pyproject.toml` / `Cargo.toml` parsed via `@iarna/toml`; `pom.xml` via `fast-xml-parser` — no regex scan on large files.
- **GraphStore**: caps protect against huge graphs (dropping oldest edges). Web UI virtualizes large trees via `react-window` (when enabled).

## Benchmarks (indicative, local machine)

| Repo size | Index time | Memory |
|-----------|------------|--------|
| 100 files | ~2 s | ~100 MB |
| 1 000 files | ~8 s | ~250 MB |
| 10 000 files (e.g. VS Code) | <60 s | <500 MB |

Run your own: `npm start -- /path/to/repo` and check `indexed: {files, syms, imports, calls}` log line.
