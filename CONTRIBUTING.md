# Contributing to Archiviz

Thanks for considering a contribution! This is a local-first, deterministic code explorer — help us keep it simple and accurate.

## Dev setup

```bash
npm install
cd web && npm install && cd ..

npm test          # vitest (55+ tests)
npx tsc --noEmit  # typecheck
npm run build     # server + frontend
npm start         # run from dist
npm run dev       # tsx watch
```

## Adding a new language

1. Check if `tree-sitter-wasms` already ships the WASM:
   ```bash
   ls node_modules/tree-sitter-wasms/out/tree-sitter-*.wasm
   ```
   If not, you can still add the `LANGUAGES` entry but WASM loading will warn and skip at runtime. Prefer languages that ship with `tree-sitter-wasms`.

2. Add a `LANGUAGES` entry in `src/index/treeSitterEngine.ts`:
   ```ts
   mylang: {
     symbolTypes: new Set(['function_declaration', 'class_declaration']),
     importType: 'import_statement',
     importPathField: 'source',
     callTypes: new Set(['call_expression']),
     calleeField: 'function',
     kindFromNode: (t) => t.includes('class') ? 'class' : 'function',
   },
   ```
   - `symbolTypes`: tree-sitter node types that are symbols.
   - `importType`: node type for import/include. Set to `''` for data-only languages.
   - `callTypes`: node types that are call expressions. Empty set for data languages.
   - `kindFromNode`: map node type to `class` or `function`.

3. Add extension mappings to `EXT_LANG` in the same file.

4. If the language has popular frameworks, add entries to `SYSTEM_SIGNATURES` in `src/index/context.ts`.

5. Add a fixture and a test: create `tests/fixtures/mylang-*` and add coverage in `tests/`.

6. Test against a real project:
   ```bash
   npm run build && node dist/server.js /path/to/real-project
   ```

## Adding a new manifest format

1. Add a parser function in `src/index/manifests.ts`:
   ```ts
   function parseMyFormat(root: string, rel: string, deps: ManifestDeps) {
     const text = readText(root, rel);
     if (!text) return;
     // ...
     add(deps, pkgName, rel);
   }
   ```
2. Register it in `ROOT_MANIFEST_PARSERS` (for root-level files) or `GLOB_PARSERS` (for anywhere in tree).
3. Add a test in `tests/manifests.test.ts`.

## Adding framework awareness

Add entries to `SYSTEM_SIGNATURES` in `src/index/context.ts`. Each entry maps a package name to its known symbols (classes, functions, constants). This lets Archiviz recognize framework calls even when the framework source isn't indexed.

## Code style

- Strict TypeScript, `NodeNext` module.
- No `any` without justification; prefer precise types.
- Keep functions small and testable.
- Run `npx tsc --noEmit` and `npm test` before pushing.

## Release checklist (maintainers)

- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `RELEASE_BUILD=1 npm run fetch-gopls -- --force` (if publishing with vendored gopls)
- [ ] Update `CHANGELOG.md`
- [ ] Bump version in `package.json` and `web/package.json` if needed
- [ ] Tag and publish to npm
