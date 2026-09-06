import { describe, it, expect } from 'vitest';
import { GraphStore } from '../src/index/store';
import { traceCallChain, findEntryPoints, MAX_TRACE_DEPTH } from '../src/index/trace';

function sym(id: string, name: string, fileId: string, startLine = 1): any {
  return { id, kind: 'function', name, fileId, startLine, endLine: startLine, signature: `${name}()` };
}

describe('traceCallChain', () => {
  it('returns null for missing symbol', () => {
    const s = new GraphStore();
    expect(traceCallChain(s, 'nope:nope')).toBeNull();
  });

  it('returns entry with empty steps for leaf symbol', () => {
    const s = new GraphStore();
    s.addSymbol(sym('a.ts:foo', 'foo', 'a.ts'));
    const t = traceCallChain(s, 'a.ts:foo');
    expect(t).not.toBeNull();
    expect(t!.steps.length).toBe(0);
    expect(t!.truncated).toBe(false);
    expect(t!.entry.id).toBe('a.ts:foo');
  });

  it('follows call chain and detects recursion', () => {
    const s = new GraphStore();
    s.addSymbol(sym('a.ts:foo', 'foo', 'a.ts'));
    s.addSymbol(sym('a.ts:bar', 'bar', 'a.ts', 5));
    s.addSymbol(sym('a.ts:baz', 'baz', 'a.ts', 10));
    s.addEdge('a.ts:foo', 'a.ts:bar', 'calls');
    s.addEdge('a.ts:bar', 'a.ts:baz', 'calls');
    s.addEdge('a.ts:baz', 'a.ts:foo', 'calls'); // recursive cycle
    const t = traceCallChain(s, 'a.ts:foo');
    expect(t).not.toBeNull();
    expect(t!.steps.length).toBe(3);
    const recursive = t!.steps.find(st => st.callLabel.includes('recursive'));
    expect(recursive).toBeDefined();
  });

  it('respects MAX_TRACE_DEPTH and sets truncated', () => {
    const s = new GraphStore();
    s.addSymbol(sym('a.ts:f0', 'f0', 'a.ts'));
    let prev = 'a.ts:f0';
    for (let i = 1; i <= MAX_TRACE_DEPTH + 10; i++) {
      const id = `a.ts:f${i}`;
      s.addSymbol(sym(id, `f${i}`, 'a.ts', i + 1));
      s.addEdge(prev, id, 'calls');
      prev = id;
    }
    const t = traceCallChain(s, 'a.ts:f0');
    expect(t).not.toBeNull();
    expect(t!.truncated).toBe(true);
    expect(t!.truncatedAt).toBeGreaterThan(0);
    expect(t!.steps.length).toBeLessThanOrEqual(MAX_TRACE_DEPTH);
  });

  it('exposes maxDepth in result', () => {
    const s = new GraphStore();
    s.addSymbol(sym('a.ts:foo', 'foo', 'a.ts'));
    const t = traceCallChain(s, 'a.ts:foo');
    expect(t!.maxDepth).toBe(MAX_TRACE_DEPTH);
  });
});

describe('findEntryPoints', () => {
  it('returns symbols that have callees', () => {
    const s = new GraphStore();
    s.addSymbol(sym('a.ts:main', 'main', 'a.ts'));
    s.addSymbol(sym('a.ts:helper', 'helper', 'a.ts', 5));
    s.addSymbol(sym('a.ts:unused', 'unused', 'a.ts', 10));
    s.addEdge('a.ts:main', 'a.ts:helper', 'calls');
    const ep = findEntryPoints(s);
    const ids = ep.map(e => e.id);
    expect(ids).toContain('a.ts:main');
    expect(ids).not.toContain('a.ts:helper');
    expect(ids).not.toContain('a.ts:unused');
  });
});
