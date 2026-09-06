# Getting Started

```bash
npx codivizer /path/to/your/project
# or
npm install -g codivizer
Codivizer /path/to/your/project
```

Open http://127.0.0.1:4840 (opens automatically). Use `--port 5000` and `--no-open` as needed.

## First run

1. Pick a repo with indexed files (TS, JS, Python, Go, or any of the 32 tree-sitter languages).
2. Wait for indexing and optional AI annotation (needs `ARCHI_AI_KEY` or Settings UI).
3. Explore: Brief -> Context -> Overview -> click a component -> files and dependencies -> click a symbol -> Trace.

## AI keys

Only Google AI Studio keys are supported for now. Set via env (`ARCHI_AI_KEY`), `.env`, or Settings UI (stored in `~/.archi/config.json`). One call per indexing annotates all views.
