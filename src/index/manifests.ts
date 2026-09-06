import * as fs from 'node:fs';
import * as path from 'node:path';
import * as toml from '@iarna/toml';
import { XMLParser } from 'fast-xml-parser';
import type { GraphStore } from './store.js';

export type ManifestDeps = Map<string, Set<string>>;

function readText(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function add(deps: ManifestDeps, name: string, source: string) {
  const clean = name.trim();
  if (!clean || clean.length < 2 || clean.length > 200) return;
  if (/^[\d._-]+$/.test(clean)) return;
  let set = deps.get(clean);
  if (!set) {
    set = new Set();
    deps.set(clean, set);
  }
  set.add(source);
}

// ---------- per-format parsers ----------

function parsePackageJson(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const pkg = JSON.parse(text);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const obj = pkg[section];
      if (!obj || typeof obj !== 'object') continue;
      for (const name of Object.keys(obj)) {
        if (name.startsWith('@types/')) continue;
        add(deps, name, rel);
      }
    }
  } catch {
    /* invalid json */
  }
}

function parseRequirementsTxt(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // PEP 508: name[extras] (version_spec) ; markers @ url
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) add(deps, m[1], rel);
  }
}

function addFromPyprojectToml(obj: any, rel: string, deps: ManifestDeps) {
  // [project] dependencies
  if (obj?.project?.dependencies && Array.isArray(obj.project.dependencies)) {
    for (const d of obj.project.dependencies) {
      if (typeof d === 'string') {
        const m = d.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
        if (m) add(deps, m[1], rel);
      }
    }
  }
  // [project.optional-dependencies]
  const opt = obj?.project?.['optional-dependencies'];
  if (opt && typeof opt === 'object') {
    for (const group of Object.values(opt) as string[][]) {
      for (const d of group) {
        const m = d.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
        if (m) add(deps, m[1], rel);
      }
    }
  }
  // [dependency-groups]
  const dg = obj?.['dependency-groups'];
  if (dg && typeof dg === 'object') {
    for (const group of Object.values(dg) as string[][]) {
      for (const d of group) {
        const m = d.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
        if (m) add(deps, m[1], rel);
      }
    }
  }
  // [tool.poetry] dependencies and [tool.poetry.group.*.dependencies]
  const poetry = obj?.tool?.poetry;
  if (poetry) {
    const collect = (table: any) => {
      if (!table || typeof table !== 'object') return;
      for (const name of Object.keys(table)) {
        if (name === 'python') continue;
        add(deps, name, rel);
      }
    };
    collect(poetry.dependencies);
    if (poetry.group && typeof poetry.group === 'object') {
      for (const g of Object.values(poetry.group) as any[]) {
        collect(g?.dependencies);
      }
    }
  }
  // [tool.uv] dependencies and [tool.uv.sources]
  const uv = obj?.tool?.uv;
  if (uv?.dependencies && Array.isArray(uv.dependencies)) {
    for (const d of uv.dependencies) {
      const m = String(d).match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
      if (m) add(deps, m[1], rel);
    }
  }
  // [tool.pdm] dependencies and [tool.pdm.dev-dependencies]
  const pdm = obj?.tool?.pdm;
  if (pdm) {
    const collect = (table: any) => {
      if (!table || typeof table !== 'object') return;
      for (const name of Object.keys(table)) {
        add(deps, name, rel);
      }
    };
    collect(pdm.dependencies);
    collect(pdm['dev-dependencies']);
  }
  // [tool.hatch] env
  // [tool.flit] metadata
  // (no standard deps table for these in flit/hatch)
}

function parsePyprojectToml(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const obj = toml.parse(text);
    addFromPyprojectToml(obj, rel, deps);
  } catch {
    // Fallback: simple regex for the common cases so we still extract *something*
    const projArr = text.match(/dependencies\s*=\s*\[([^\]]*)\]/s);
    if (projArr) {
      for (const m of projArr[1].matchAll(/["']([A-Za-z0-9._-]+)[^"']*["']/g)) {
        add(deps, m[1], rel);
      }
    }
    const section = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
    if (section) {
      for (const line of section[1].split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9._-]+)\s*=/);
        if (m && m[1] !== 'python') add(deps, m[1], rel);
      }
    }
  }
}

function parseGoMod(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('require (')) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const m = (inBlock ? line : line.replace(/^require\s+/, '')).match(/^(\S+)\s+v[\w.-]/);
    if (m) {
      const mod = m[1];
      const first = mod.split('/')[0];
      if (!first.includes('.')) continue; // skip stdlib
      add(deps, mod, rel);
    }
  }
}

function parsePomXml(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: false,
    });
    const obj = parser.parse(text);
    const collect = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const x of node) collect(x);
        return;
      }
      if (node.groupId && node.artifactId) {
        add(deps, `${node.groupId}:${node.artifactId}`, rel);
      } else if (node.artifactId && (node.groupId === undefined)) {
        add(deps, node.artifactId, rel);
      }
      for (const k of Object.keys(node)) {
        if (k.startsWith('@_') || k === '#text') continue;
        const v = node[k];
        if (Array.isArray(v)) for (const x of v) collect(x);
        else if (typeof v === 'object') collect(v);
      }
    };
    collect(obj);
  } catch {
    for (const m of text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
      add(deps, m[1], rel);
    }
  }
}

const GRADLE_SCOPES = new Set([
  'implementation', 'api', 'compileOnly', 'runtimeOnly',
  'testImplementation', 'testRuntimeOnly', 'testCompileOnly',
  'kapt', 'ksp', 'annotationProcessor',
  'compile', 'runtime', 'provided',
]);

function parseGradle(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  // Match scope followed by a triple-colon string. Allow either quote style.
  // Patterns: implementation "g:a:v"   implementation 'g:a:v'   implementation("g:a:v")
  const scopePattern = [...GRADLE_SCOPES].join('|');
  const regex = new RegExp(
    `(?:${scopePattern})\\s*[(]?\\s*["']([^"']+):([^"']+):([^"']+)["']`,
    'g'
  );
  for (const m of text.matchAll(regex)) {
    add(deps, m[2], rel);
  }
}

function addCargoDepsFromTable(table: any, rel: string, deps: ManifestDeps) {
  if (!table || typeof table !== 'object') return;
  for (const name of Object.keys(table)) {
    if (name === 'package' || name === 'target' || name === 'workspace' || name === 'features') continue;
    add(deps, name, rel);
  }
}

function parseCargoToml(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const obj = toml.parse(text) as any;
    addCargoDepsFromTable(obj.dependencies, rel, deps);
    addCargoDepsFromTable(obj['dev-dependencies'], rel, deps);
    addCargoDepsFromTable(obj['build-dependencies'], rel, deps);
    // [workspace.dependencies]
    addCargoDepsFromTable(obj.workspace?.dependencies, rel, deps);
  } catch {
    // Fallback to regex
    const section = text.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
    if (section) {
      for (const line of section[1].split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9._-]+)\s*=/);
        if (m) add(deps, m[1], rel);
      }
    }
  }
}

function parseComposerJson(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const pkg = JSON.parse(text);
    for (const section of ['require', 'require-dev']) {
      const obj = pkg[section];
      if (!obj || typeof obj !== 'object') continue;
      for (const name of Object.keys(obj)) {
        if (name.startsWith('ext-') || name === 'php') continue;
        add(deps, name, rel);
      }
    }
  } catch {
    /* invalid json */
  }
}

function parseGemfile(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  // Phase 4 enhancement: parse `group :development do ... end` blocks too.
  // We match gem "name" globally; groups don't change what's a gem.
  for (const m of text.matchAll(/gem\s+["']([^"']+)["']/g)) {
    add(deps, m[1], rel);
  }
}

function parseCsproj(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  // <PackageReference Include="name" Version="x" />
  for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"[^>]*Version="([^"]+)"/g)) {
    add(deps, m[1], rel);
  }
}

function parseCsprojProps(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  // Directory.Packages.props: <PackageVersion Include="name" Version="x" />
  for (const m of text.matchAll(/<PackageVersion\s+Include="([^"]+)"[^>]*Version="([^"]+)"/g)) {
    add(deps, `${m[1]}@${m[2]}`, rel);
  }
}

// ---------- new manifest parsers (Phase 4.10) ----------

function parseMixExs(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  for (const m of text.matchAll(/\{[:\s]*[:"]*([a-z_][a-z0-9_]*)/gi)) {
    add(deps, m[1], rel);
  }
}

function parseRockspec(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  for (const m of text.matchAll(/["']([a-z][a-z0-9_-]+)["']\s*=\s*["'][^"']+["']/gi)) {
    add(deps, m[1], rel);
  }
}

function parseVcpkgJson(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj.dependencies)) {
      for (const d of obj.dependencies) {
        if (typeof d === 'string') add(deps, d, rel);
        else if (d?.name) add(deps, d.name, rel);
      }
    }
  } catch { /* ignore */ }
}

function parseConanfile(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  // requires = "pkg/1.0" or list form
  const single = text.match(/^\s*requires\s*=\s*["']([^"']+)["']/m);
  if (single) {
    const m = single[1].match(/^([A-Za-z0-9._-]+)/);
    if (m) add(deps, m[1], rel);
  }
  for (const m of text.matchAll(/self\.requires\(["']([^"']+)["']\)/g)) {
    const name = m[1].match(/^([A-Za-z0-9._-]+)/);
    if (name) add(deps, name[1], rel);
  }
}

function parseDenoJson(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const obj = JSON.parse(text);
    const collect = (m: any) => {
      if (!m || typeof m !== 'object') return;
      for (const k of Object.keys(m)) add(deps, k, rel);
    };
    collect(obj.imports);
    collect(obj.dependencies);
    collect(obj.devDependencies);
  } catch { /* ignore */ }
}

// ---------- entry point ----------

const ROOT_MANIFEST_PARSERS: [string, (root: string, rel: string, deps: ManifestDeps) => void][] = [
  ['package.json', parsePackageJson],
  ['requirements.txt', parseRequirementsTxt],
  ['pyproject.toml', parsePyprojectToml],
  ['go.mod', parseGoMod],
  ['pom.xml', parsePomXml],
  ['Cargo.toml', parseCargoToml],
  ['composer.json', parseComposerJson],
  ['Gemfile', parseGemfile],
  ['mix.exs', parseMixExs],
  ['vcpkg.json', parseVcpkgJson],
  ['conanfile.txt', parseConanfile],
  ['deno.json', parseDenoJson],
  ['import_map.json', parseDenoJson],
];

const GLOB_PARSERS: Array<{
  match: (rel: string) => boolean;
  parse: (root: string, rel: string, deps: ManifestDeps) => void;
}> = [
  { match: (r) => r.endsWith('.gradle') || r.endsWith('.gradle.kts'), parse: parseGradle },
  { match: (r) => r.endsWith('.csproj'), parse: parseCsproj },
  { match: (r) => r.endsWith('.rockspec'), parse: parseRockspec },
];

const PROPS_PARSERS: Array<{
  match: (rel: string) => boolean;
  parse: (root: string, rel: string, deps: ManifestDeps) => void;
}> = [
  // C# Central Package Management
  { match: (r) => r === 'Directory.Packages.props' || r.endsWith('.props'), parse: parseCsprojProps },
];

export function loadManifests(root: string, files: string[], store: GraphStore): void {
  const deps: ManifestDeps = new Map();

  // 1. Root-level manifests (Phase 4.8 + 4.10 additions)
  for (const [name, parser] of ROOT_MANIFEST_PARSERS) {
    if (files.includes(name)) parser(root, name, deps);
  }

  // 2. Glob-matching parsers (anywhere in the tree)
  for (const f of files) {
    for (const g of GLOB_PARSERS) {
      if (g.match(f)) g.parse(root, f, deps);
    }
  }

  // 3. C# props files
  for (const f of files) {
    for (const p of PROPS_PARSERS) {
      if (p.match(f)) p.parse(root, f, deps);
    }
  }

  // 4. Phase 4.8: monorepo workspaces — find nested package.json, Cargo.toml, etc.
  detectMonorepo(root, files, deps);

  // Phase 4.9: composer.json at any depth (already handled via GLOB-like walk;
  // we add it to root parsers too if it appears)
  for (const f of files) {
    if (f.endsWith('/composer.json') && f !== 'composer.json') {
      parseComposerJson(root, f, deps);
    }
  }

  for (const [name, sources] of deps) {
    store.addManifestDep(name, [...sources].join(', '));
  }
}

function detectMonorepo(root: string, files: string[], deps: ManifestDeps) {
  // Read root package.json's "workspaces" field and index nested package.json files.
  if (!files.includes('package.json')) return;
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch { return; }
  const ws = pkg.workspaces;
  if (!ws) return;
  const patterns: string[] = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  if (patterns.length === 0) return;

  // Phase 4.8: parse all package.json files at any depth (workspace members)
  for (const f of files) {
    if (f.endsWith('/package.json') || f === 'package.json') {
      parsePackageJson(root, f, deps);
    }
    if (f.endsWith('/Cargo.toml')) {
      parseCargoToml(root, f, deps);
    }
    if (f.endsWith('/pom.xml')) {
      parsePomXml(root, f, deps);
    }
  }
}
