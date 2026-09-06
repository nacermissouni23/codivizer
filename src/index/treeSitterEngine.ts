import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import pLimit from 'p-limit';
import type { GraphStore, Sym } from './store.js';

const require = createRequire(import.meta.url);

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

let ParserClass: any;
let initialized = false;

async function initTreeSitter() {
  if (initialized) return;
  const TS = await import('web-tree-sitter');
  ParserClass = TS.default;
  await ParserClass.init();
  initialized = true;
}

// ---------- language definitions ----------

interface LangDef {
  /** node types that are symbol definitions */
  symbolTypes: Set<string>;
  /** node type for import/include */
  importType: string;
  /** field name containing the import path (or null for child) */
  importPathField: string | null;
  /** node types that are call expressions */
  callTypes: Set<string>;
  /** field name for the callee in a call expression */
  calleeField: string | null;
  /** how to map a found name to Sym kind */
  kindFromNode: (nodeType: string) => Sym['kind'];
}

const LANGUAGES: Record<string, LangDef> = {
  c: {
    symbolTypes: new Set(['function_definition', 'struct_specifier', 'enum_specifier']),
    importType: 'preproc_include',
    importPathField: null,
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t === 'struct_specifier' || t === 'enum_specifier' ? 'class' : 'function',
  },
  cpp: {
    symbolTypes: new Set(['function_definition', 'class_specifier', 'struct_specifier', 'enum_specifier', 'namespace_definition']),
    importType: 'preproc_include',
    importPathField: null,
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('class') || t.includes('struct') || t.includes('enum') || t.includes('namespace') ? 'class' : 'function',
  },
  rust: {
    symbolTypes: new Set(['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item', 'mod_item']),
    importType: 'use_declaration',
    importPathField: null,
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t === 'impl_item' || t === 'struct_item' || t === 'enum_item' || t === 'trait_item' ? 'class' : 'function',
  },
  ruby: {
    symbolTypes: new Set(['method', 'singleton_method', 'class', 'module']),
    importType: 'call',
    importPathField: null,
    callTypes: new Set(['call']),
    calleeField: 'method',
    kindFromNode: (t) => t === 'class' || t === 'module' ? 'class' : 'function',
  },
  php: {
    symbolTypes: new Set(['function_definition', 'class_declaration', 'interface_declaration', 'trait_declaration']),
    importType: 'namespace_use_declaration',
    importPathField: null,
    callTypes: new Set(['function_call_expression', 'method_call_expression']),
    calleeField: 'name',
    kindFromNode: (t) => t.includes('class') || t.includes('interface') || t.includes('trait') ? 'class' : 'function',
  },
  kotlin: {
    symbolTypes: new Set(['function_declaration', 'class_declaration', 'object_declaration', 'interface_declaration']),
    importType: 'import_header',
    importPathField: null,
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('class') || t.includes('object') || t.includes('interface') ? 'class' : 'function',
  },
  swift: {
    symbolTypes: new Set(['function_declaration', 'class_declaration', 'struct_declaration', 'protocol_declaration', 'enum_declaration']),
    importType: 'import_declaration',
    importPathField: null,
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('class') || t.includes('struct') || t.includes('protocol') || t.includes('enum') ? 'class' : 'function',
  },
  c_sharp: {
    symbolTypes: new Set(['method_declaration', 'class_declaration', 'interface_declaration', 'struct_declaration', 'enum_declaration']),
    importType: 'using_directive',
    importPathField: null,
    callTypes: new Set(['invocation_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('class') || t.includes('interface') || t.includes('struct') || t.includes('enum') ? 'class' : 'function',
  },
  java: {
    symbolTypes: new Set(['method_declaration', 'class_declaration', 'interface_declaration', 'enum_declaration']),
    importType: 'import_declaration',
    importPathField: null,
    callTypes: new Set(['method_invocation']),
    calleeField: 'name',
    kindFromNode: (t) => t.includes('class') || t.includes('interface') || t.includes('enum') ? 'class' : 'function',
  },
  go: {
    symbolTypes: new Set(['function_declaration', 'method_declaration', 'type_declaration']),
    importType: 'import_declaration',
    importPathField: null,
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: () => 'function',
  },
  python: {
    symbolTypes: new Set(['function_definition', 'class_definition']),
    importType: 'import_statement',
    importPathField: null,
    callTypes: new Set(['call']),
    calleeField: 'function',
    kindFromNode: (t) => t === 'class_definition' ? 'class' : 'function',
  },
  javascript: {
    symbolTypes: new Set(['function_declaration', 'function', 'class_declaration', 'arrow_function']),
    importType: 'import_statement',
    importPathField: 'source',
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t === 'class_declaration' ? 'class' : 'function',
  },
  typescript: {
    symbolTypes: new Set(['function_declaration', 'function', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'arrow_function']),
    importType: 'import_statement',
    importPathField: 'source',
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('class') || t.includes('interface') || t.includes('enum') ? 'class' : 'function',
  },
  // ---- additional languages ----
  bash: {
    symbolTypes: new Set(['function_definition']),
    importType: 'command',
    importPathField: null,
    callTypes: new Set(['command_name']),
    calleeField: null,
    kindFromNode: () => 'function',
  },
  dart: {
    symbolTypes: new Set(['function_declaration', 'class_declaration', 'enum_declaration', 'mixin_declaration', 'extension_declaration']),
    importType: 'import_or_export',
    importPathField: null,
    callTypes: new Set(['function_call_expression', 'constructorInvocation']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('class') || t.includes('enum') || t.includes('mixin') || t.includes('extension') ? 'class' : 'function',
  },
  elixir: {
    symbolTypes: new Set(['function_definition', 'call']),
    importType: 'call',
    importPathField: null,
    callTypes: new Set(['call']),
    calleeField: 'target',
    kindFromNode: () => 'function',
  },
  elm: {
    symbolTypes: new Set(['function_declaration', 'type_declaration', 'union_type_declaration']),
    importType: 'import_clause',
    importPathField: null,
    callTypes: new Set(['function_call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('type') ? 'class' : 'function',
  },
  lua: {
    symbolTypes: new Set(['function_declaration', 'function_definition']),
    importType: 'function_call',
    importPathField: null,
    callTypes: new Set(['function_call']),
    calleeField: 'function',
    kindFromNode: () => 'function',
  },
  objc: {
    symbolTypes: new Set(['function_definition', 'class_interface', 'class_implementation', 'protocol_declaration', 'category_interface']),
    importType: 'preproc_include',
    importPathField: null,
    callTypes: new Set(['message_expression']),
    calleeField: 'receiver',
    kindFromNode: (t) => t.includes('class') || t.includes('protocol') || t.includes('category') ? 'class' : 'function',
  },
  ocaml: {
    symbolTypes: new Set(['function_definition', 'class_definition', 'module_definition', 'type_definition']),
    importType: 'open_statement',
    importPathField: null,
    callTypes: new Set(['application_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('class') || t.includes('module') || t.includes('type') ? 'class' : 'function',
  },
  scala: {
    symbolTypes: new Set(['function_definition', 'class_definition', 'object_definition', 'trait_definition']),
    importType: 'import_declaration',
    importPathField: null,
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('class') || t.includes('object') || t.includes('trait') ? 'class' : 'function',
  },
  zig: {
    symbolTypes: new Set(['function_declaration', 'declaration']),
    importType: '@import',
    importPathField: null,
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: () => 'function',
  },
  yaml: {
    symbolTypes: new Set(['block_mapping_pair']),
    importType: '',
    importPathField: null,
    callTypes: new Set(),
    calleeField: null,
    kindFromNode: () => 'function',
  },
  toml: {
    symbolTypes: new Set(['table', 'table_array_element']),
    importType: '',
    importPathField: null,
    callTypes: new Set(),
    calleeField: null,
    kindFromNode: () => 'function',
  },
  json: {
    symbolTypes: new Set(['pair']),
    importType: '',
    importPathField: null,
    callTypes: new Set(),
    calleeField: null,
    kindFromNode: () => 'function',
  },
  css: {
    symbolTypes: new Set(['rule_set', 'at_rule', 'keyframes_statement', 'media_statement']),
    importType: 'import_statement',
    importPathField: null,
    callTypes: new Set(),
    calleeField: null,
    kindFromNode: () => 'class',
  },
  html: {
    symbolTypes: new Set(['element', 'script_element', 'style_element']),
    importType: 'script_element',
    importPathField: null,
    callTypes: new Set(),
    calleeField: null,
    kindFromNode: () => 'class',
  },
  vue: {
    symbolTypes: new Set(['element', 'script_element', 'style_element', 'template_element']),
    importType: 'import_statement',
    importPathField: 'source',
    callTypes: new Set(['call_expression']),
    calleeField: 'function',
    kindFromNode: () => 'class',
  },
  solidity: {
    symbolTypes: new Set(['function_definition', 'contract_declaration', 'interface_declaration', 'library_declaration']),
    importType: 'import_directive',
    importPathField: null,
    callTypes: new Set(['function_call_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('contract') || t.includes('interface') || t.includes('library') ? 'class' : 'function',
  },
  rescript: {
    symbolTypes: new Set(['let_declaration', 'module_declaration', 'type_declaration']),
    importType: 'import_statement',
    importPathField: null,
    callTypes: new Set(['application_expression']),
    calleeField: 'function',
    kindFromNode: (t) => t.includes('module') || t.includes('type') ? 'class' : 'function',
  },
  ql: {
    symbolTypes: new Set(['class', 'predicate', 'module', 'import']),
    importType: 'import',
    importPathField: null,
    callTypes: new Set(['call']),
    calleeField: null,
    kindFromNode: (t) => t === 'class' || t === 'module' ? 'class' : 'function',
  },
  systemrdl: {
    symbolTypes: new Set(['component_definition', 'enum_definition']),
    importType: '',
    importPathField: null,
    callTypes: new Set(),
    calleeField: null,
    kindFromNode: () => 'class',
  },
  tlaplus: {
    symbolTypes: new Set(['operator_definition', 'function_definition', 'module_definition']),
    importType: '',
    importPathField: null,
    callTypes: new Set(),
    calleeField: null,
    kindFromNode: () => 'function',
  },
  elisp: {
    symbolTypes: new Set(['list']),
    importType: '',
    importPathField: null,
    callTypes: new Set(['list']),
    calleeField: null,
    kindFromNode: () => 'function',
  },
  embedded_template: {
    symbolTypes: new Set(['content', 'output', 'tag']),
    importType: 'partial_statement',
    importPathField: null,
    callTypes: new Set(),
    calleeField: null,
    kindFromNode: () => 'function',
  },
};

const EXT_LANG: Record<string, string> = {
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift',
  '.cs': 'c_sharp',
  '.java': 'java',
  '.go': 'go',
  '.py': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.jsx': 'javascript',
  '.bash': 'bash', '.sh': 'bash', '.zsh': 'bash',
  '.dart': 'dart',
  '.ex': 'elixir', '.exs': 'elixir',
  '.elm': 'elm',
  '.lua': 'lua',
  '.m': 'objc', '.mm': 'objc',
  '.ml': 'ocaml', '.mli': 'ocaml',
  '.scala': 'scala', '.sc': 'scala',
  '.zig': 'zig',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.json': 'json',
  '.css': 'css', '.scss': 'css', '.less': 'css',
  '.html': 'html', '.htm': 'html', '.vue': 'vue',
  '.svelte': 'vue', '.astro': 'vue',
  '.sol': 'solidity',
  '.res': 'rescript',
  '.ql': 'ql', '.qll': 'ql',
  '.el': 'elisp',
  '.erb': 'ruby',
  '.hbs': 'embedded_template', '.ejs': 'embedded_template',
  '.j2': 'embedded_template', '.jinja': 'embedded_template', '.jinja2': 'embedded_template',
};

export function getTreeSitterLang(ext: string): string | undefined {
  return EXT_LANG[ext.toLowerCase()];
}

// ---------- helpers ----------

/** Extract a name from a definition node by walking its children. */
function getNodeName(node: any): string | null {
  // Try field-based access first
  for (const typeName of ['name', 'identifier', 'type_identifier', 'field_identifier', 'simple_identifier', 'constant']) {
    const child = node.childForFieldName(typeName);
    if (child) return child.text;
  }
  // C/C++: struct_specifier without a type_identifier child is anonymous (typedef struct { ... } Name)
  if (node.type === 'struct_specifier' || node.type === 'class_specifier') {
    // Check if it has a direct type_identifier child (named struct)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child.type === 'type_identifier') return child.text;
    }
    return null; // anonymous struct/class
  }
  // C/C++: function_definition -> declarator -> function_declarator -> identifier
  // Walk recursively looking for identifier/type_identifier/field_identifier
  const findName = (n: any, depth: number): string | null => {
    if (!n || depth > 6) return null;
    if (n.type === 'identifier' || n.type === 'type_identifier' || n.type === 'field_identifier' || n.type === 'simple_identifier' || n.type === 'constant') {
      return n.text;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const r = findName(n.namedChild(i), depth + 1);
      if (r) return r;
    }
    return null;
  };
  return findName(node, 0);
}

/** Extract import path from an import/include node. */
function getImportPath(node: any, langDef: LangDef): string | null {
  if (langDef.importPathField) {
    const field = node.childForFieldName(langDef.importPathField);
    if (field) {
      let text = field.text;
      if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
      if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1);
      return text;
    }
  }
  // Walk children looking for string-like nodes
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === 'string_literal' || child.type === 'system_lib_string' || child.type === 'string' || child.type === 'interpreted_string_literal') {
      let t = child.text;
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
      if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
      return t;
    }
  }
  return null;
}

/** Extract callee name from a call expression. */
function getCalleeName(node: any, langDef: LangDef): string | null {
  if (langDef.calleeField) {
    const field = node.childForFieldName(langDef.calleeField);
    if (field) {
      if (field.type === 'identifier' || field.type === 'field_identifier' || field.type === 'simple_identifier') {
        return field.text;
      }
      // For qualified/chained names, get the last identifier
      let last: string | null = null;
      const walkAll = (n: any) => {
        if (!n) return;
        if (n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'simple_identifier') last = n.text;
        for (let i = 0; i < n.namedChildCount; i++) walkAll(n.namedChild(i));
      };
      walkAll(field);
      return last;
    }
  }
  // Fallback: first named child that looks like a name
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === 'identifier' || child.type === 'field_identifier') return child.text;
  }
  return null;
}

function resolveImportPath(rawPath: string, ext: string, nodeType?: string): string | null {
  if (!rawPath) return null;
  // C/C++: system headers use <>, local includes use ""
  if (['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx'].includes(ext)) {
    // <stdio.h> style = system, "foo.h" style = local
    if (nodeType === 'system_lib_string') return null;
    return rawPath; // local include
  }
  // Rust: crate::foo::bar -> foo/bar
  if (ext === '.rs') return rawPath.replace(/::/g, '/');
  // Ruby: "foo" -> foo.rb
  if (ext === '.rb') return rawPath.endsWith('.rb') ? rawPath : rawPath + '.rb';
  // PHP: App\Foo\Bar -> App/Foo/Bar.php
  if (ext === '.php') return rawPath.replace(/\\/g, '/') + '.php';
  // Java: com.example.Foo -> com/example/Foo.java
  if (ext === '.java') return rawPath.replace(/\./g, '/') + '.java';
  // Kotlin: com.example.Foo -> com/example/Foo.kt
  if (ext === '.kt' || ext === '.kts') return rawPath.replace(/\./g, '/') + '.kt';
  // C#: Foo.Bar -> Foo/Bar
  if (ext === '.cs') return rawPath.replace(/\./g, '/');
  // Swift: module only, not file-level
  if (ext === '.swift') return null;
  // JS/TS: relative only
  if (['.js', '.mjs', '.cjs', '.ts', '.mts', '.tsx'].includes(ext)) {
    if (rawPath.startsWith('.')) return rawPath;
    return null;
  }
  return null;
}

function isStdlibC(rawPath: string): boolean {
  // C/C++ system headers don't start with .
  return !rawPath.startsWith('.');
}

function addExternalForImport(rawPath: string, rel: string, ext: string, store: any) {
  if (!rawPath) return;
  // C/C++: system headers
  if (['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx'].includes(ext) && !rawPath.startsWith('.')) {
    store.addExternal(rawPath.split('/')[0], rel);
  }
}

export interface TreeSitterResult {
  symbols: number;
  calls: number;
  imports: number;
  files: number;
}

export async function indexTreeSitter(
  root: string,
  files: string[],
  store: GraphStore
): Promise<TreeSitterResult> {
  await initTreeSitter();

  // Group files by language
  const byLang = new Map<string, string[]>();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const lang = EXT_LANG[ext];
    if (!lang || !LANGUAGES[lang]) continue;
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang)!.push(f);
  }

  if (byLang.size === 0) return { symbols: 0, calls: 0, imports: 0, files: 0 };

  const parser = new ParserClass();
  let totalSymbols = 0;
  let totalCalls = 0;
  let totalImports = 0;
  let totalFiles = 0;

  const limit = pLimit(Math.max(1, os.cpus().length));

  for (const [lang, langFiles] of byLang) {
    // Load language WASM
    let wasmLang: any;
    const wasmKey = lang === 'typescript' ? 'typescript' : lang === 'javascript' ? 'javascript' : lang;
    // Handle tsx separately: map typescript -> try tsx wasm for .tsx files handled below
    // For now typescript lang covers both .ts/.tsx via typescript WASM
    try {
      const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${wasmKey}.wasm`);
      wasmLang = await ParserClass.Language.load(wasmPath);
    } catch (e) {
      console.warn(`  tree-sitter: grammar not found for ${lang} - ${e}`);
      continue;
    }

    parser.setLanguage(wasmLang);
    const langDef = LANGUAGES[lang];

    const parseOne = async (rel: string) => {
      try {
        const st = fs.statSync(path.join(root, rel));
        if (st.size > MAX_FILE_SIZE_BYTES) {
          console.warn(`  tree-sitter: skipping ${rel} (exceeds 20 MB)`);
          return;
        }
      } catch { /* ignore */ }
      let text: string;
      try {
        text = fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        return;
      }
      let tree: any;
      try {
        tree = parser.parse(text);
      } catch (e) {
        console.warn(`  tree-sitter: parse failed for ${rel} - ${e}`);
        return;
      }
      const treeRoot = tree.rootNode;

      // Track symbols in this file for call resolution
      const fileSyms = new Map<string, { node: any; kind: Sym['kind']; name: string }>();
      const fileSymNames = new Map<string, string>(); // name -> id (exact)

      // --- pass 1: symbols ---
      const collectSymbols = (node: any) => {
        if (langDef.symbolTypes.has(node.type)) {
          const name = getNodeName(node);
          if (name && name.length > 0) {
            const kind = langDef.kindFromNode(node.type);
            const id = `${rel}:treesym:${name}`;
            if (!fileSyms.has(id)) {
              fileSyms.set(id, { node, kind, name });
              if (!fileSymNames.has(name)) fileSymNames.set(name, id);
              const sym: Sym = {
                id, kind, name, fileId: rel,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                signature: `${name}()`,
              };
              store.addSymbol(sym);
              store.addEdge(rel, id, 'contains');
              totalSymbols++;
            }
          }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          collectSymbols(node.namedChild(i));
        }
      };
      try { collectSymbols(treeRoot); } catch { /* tree walk */ }

      // --- pass 2: imports ---
      const collectImports = (node: any) => {
        if (langDef.importType && node.type === langDef.importType) {
          const rawPath = getImportPath(node, langDef);
          if (rawPath) {
            let nodeType: string | undefined;
            for (let i = 0; i < node.namedChildCount; i++) {
              const child = node.namedChild(i);
              if (child.type === 'system_lib_string' || child.type === 'string_literal') {
                nodeType = child.type;
                break;
              }
            }
            const target = resolveImportPath(rawPath, path.extname(rel), nodeType);
            if (target && target !== rel) {
              store.addEdge(rel, target, 'imports');
              totalImports++;
            } else {
              addExternalForImport(rawPath, rel, path.extname(rel), store);
            }
          }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          collectImports(node.namedChild(i));
        }
      };
      try { collectImports(treeRoot); } catch { /* */ }

      // --- pass 3: calls (fixed: exact name match, no substring hack) ---
      const collectCalls = (node: any) => {
        if (langDef.callTypes.has(node.type)) {
          const calleeName = getCalleeName(node, langDef);
          if (calleeName) {
            let best: { id: string; node: any } | null = null;
            for (const [sid, sdata] of fileSyms) {
              const sn = sdata.node;
              if (node.startPosition.row >= sn.startPosition.row &&
                  node.endPosition.row <= sn.endPosition.row) {
                if (!best || sn.startPosition.row > best.node.startPosition.row ||
                    (sn.startPosition.row === best.node.startPosition.row && sn.startPosition.column > best.node.startPosition.column)) {
                  best = { id: sid, node: sn };
                }
              }
            }
            // Exact name match only (no substring)
            const targetId = fileSymNames.get(calleeName) ?? null;
            if (best && targetId && best.id !== targetId) {
              const before = store.edges.length;
              store.addEdge(best.id, targetId, 'calls');
              if (store.edges.length > before) totalCalls++;
            }
          }
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          collectCalls(node.namedChild(i));
        }
      };
      try { collectCalls(treeRoot); } catch { /* */ }

      try { tree.delete(); } catch { /* */ }
      totalFiles++;
    };

    // Parse in parallel with concurrency cap; parser is NOT thread-safe, so serialize per-language
    // Use sequential for now but via pLimit for future thread-safety if parser instance per task
    for (const rel of langFiles) {
      await limit(() => parseOne(rel));
    }
  }

  return { symbols: totalSymbols, calls: totalCalls, imports: totalImports, files: totalFiles };
}
