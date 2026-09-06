# Configuration

## AI

- Env: `ARCHI_AI_KEY` (or `.env`, or `~/.archi/config.json` via Settings UI)
- Model: `ARCHI_AI_MODEL` (default `gemini-flash-lite-latest`)
- Only Google AI Studio keys for now

What leaves the machine: folder names, top symbols, system kinds, edge counts. No file contents.

## Server

```bash
Codivizer [path] --port 5000 --no-open
```

Dist is served from `dist/web` on `127.0.0.1` only. File reads are blocked for `.env`, `*.pem`, etc.
