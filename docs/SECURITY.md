# Security

## Threat model

- Archiviz is a **local-only** server bound to `127.0.0.1`. No network exposure beyond localhost.
- No authentication is required because localhost access implies user access.
- Sensitive files are never indexed or served via `/api/file`.

## What Archiviz indexes

- All non-ignored files up to 20 MB in the target directory, respecting `.gitignore` and `.archivizignore`.
- Manifest files for dependency detection.
- Framework signatures are local (no network).

## What Archiviz does NOT index

- `node_modules`, `.git`, `dist`, `build`, `.venv`, `.aws`, `.ssh`, `.gnupg`, `.kube`, `.docker`, `.terraform` — skipped by walker.
- Sensitive files: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `credentials.json`, etc. — skipped and blocked via `/api/file`.
- Binary files: appear in tree but not parsed.
- Symlinks: not followed by default (prevents cycle loops).

## AI key handling

- Stored in `~/.archi/config.json` as plain text with `chmod 600` on Unix.
- Only sent to Google AI Studio API; only graph summary (folder names, top symbols, system kinds — no file contents) is transmitted.

## Hardening

- Path traversal: `realpath` canonicalization + `startsWith` check on `/api/file`.
- Body size limit: 64 KB (prevents large payload abuse).
- Rate limiting: `/api/ai/key` (5/min), `/api/index/refresh` (1/10s) via `@fastify/rate-limit`.
- CSP: `default-src 'self'; script-src 'self' wasm-unsafe-eval; style-src 'self' unsafe-inline`.
- No `unsafe-inline` for scripts where possible.

## Reporting

Please open an issue for security concerns. For sensitive reports, contact the maintainer directly.
