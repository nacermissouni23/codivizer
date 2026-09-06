import type { GraphStore, Sym } from './store.js';

export interface TraceStep {
  seq: number;
  from: { id: string; name: string; fileId: string; line: number };
  to: { id: string; name: string; fileId: string; line: number };
  callLabel: string;
}

export interface TraceResult {
  entry: { id: string; name: string; fileId: string; startLine: number; kind: string };
  steps: TraceStep[];
  truncated: boolean;
  truncatedAt?: number;
  maxDepth: number;
}

export const MAX_TRACE_DEPTH = 50;

function signatureLabel(callee: Sym): string {
  const raw = callee.signature;
  const m = raw.match(/^\s*(?:async\s+)?(?:\w+\s+)?(\w+)\s*\(([^)]*)\)/);
  if (!m) return callee.name;
  const name = m[1];
  const params = m[2]
    .split(',')
    .map((p) => p.trim().split(':')[0].split('=')[0].trim())
    .filter(Boolean);
  if (params.length <= 2) return `${name}(${params.join(', ')})`;
  return `${name}(${params[0]}, ${params[1]}, …)`;
}

export function traceCallChain(
  store: GraphStore,
  entryId: string
): TraceResult | null {
  const entry = store.getSymbol(entryId);
  if (!entry) return null;

  const steps: TraceStep[] = [];
  const visited = new Set<string>();
  const seenEdges = new Set<string>();
  let seq = 0;
  let truncated = false;
  let truncatedAt = 0;

  function dfs(symId: string, depth: number) {
    if (depth > MAX_TRACE_DEPTH) {
      truncated = true;
      truncatedAt = steps.length;
      return;
    }
    const callees = store.getCallees(symId);
    for (const edge of callees) {
      if (edge.type !== 'calls') continue;
      const edgeKey = `${symId}\u0000${edge.dst}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      const callee = store.getSymbol(edge.dst);
      if (!callee) continue;
      const caller = store.getSymbol(symId);
      if (!caller) continue;

      if (visited.has(edge.dst)) {
        seq++;
        steps.push({
          seq,
          from: { id: caller.id, name: caller.name, fileId: caller.fileId, line: caller.startLine },
          to: { id: callee.id, name: callee.name, fileId: callee.fileId, line: callee.startLine },
          callLabel: signatureLabel(callee) + ' (recursive)',
        });
        continue;
      }

      seq++;
      steps.push({
        seq,
        from: { id: caller.id, name: caller.name, fileId: caller.fileId, line: caller.startLine },
        to: { id: callee.id, name: callee.name, fileId: callee.fileId, line: callee.startLine },
        callLabel: signatureLabel(callee),
      });

      visited.add(edge.dst);
      dfs(edge.dst, depth + 1);
      visited.delete(edge.dst);
    }
  }

  visited.add(entryId);
  dfs(entryId, 1);

  return {
    entry: { id: entry.id, name: entry.name, fileId: entry.fileId, startLine: entry.startLine, kind: entry.kind },
    steps,
    truncated,
    truncatedAt: truncated ? truncatedAt : undefined,
    maxDepth: MAX_TRACE_DEPTH,
  };
}

export function findEntryPoints(store: GraphStore): { id: string; name: string; fileId: string; kind: string }[] {
  const results: { id: string; name: string; fileId: string; kind: string }[] = [];
  for (const node of store.nodes.values()) {
    if (node.type !== 'symbol' || !node.sym) continue;
    const sym = node.sym;
    const hasCallees = store.getCallees(sym.id).some((e) => e.type === 'calls');
    if (hasCallees) {
      results.push({ id: sym.id, name: sym.name, fileId: sym.fileId, kind: sym.kind });
    }
  }
  return results;
}
