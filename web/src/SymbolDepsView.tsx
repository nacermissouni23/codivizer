import { useEffect, useRef, useState } from 'react';
import { useZoomPan } from './lib/useZoomPan';
import { renderMermaid, wireNodeClicks } from './lib/mermaidInit';
import { Copy, Check, Plus, Minus, Maximize2 } from 'lucide-react';

interface Sym {
  id: string;
  kind: string;
  name: string;
  fileId: string;
  startLine: number;
  endLine: number;
  signature: string;
}

interface Rel {
  id: string;
  name: string;
  location: string;
}

function esc(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');
}

function idOf(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `n${h.toString(36)}`;
}

function symbolDepsToMermaid(symbol: Sym, callers: Rel[], callees: Rel[]): { code: string; labelToId: Map<string,string> } {
  const lines: string[] = ['flowchart LR'];
  lines.push('  classDef center fill:#5b9dd933,stroke:#5b9dd9,color:#e8ebf1,stroke-width:2px');
  lines.push('  classDef caller fill:#6f9bd11a,stroke:#6f9bd1,color:#aab3c2');
  lines.push('  classDef callee fill:#c893d81a,stroke:#c893d8,color:#aab3c2');

  const selId = idOf(symbol.id);
  const selLabel = `${symbol.name}()`;
  const labelToId = new Map<string,string>();
  labelToId.set(selLabel, symbol.id);

  // dedupe by id while keeping order
  const uniq = (arr: Rel[]) => {
    const m = new Map<string, Rel>();
    for (const r of arr) if (!m.has(r.id)) m.set(r.id, r);
    return [...m.values()];
  };
  const uCallers = uniq(callers);
  const uCallees = uniq(callees);

  for (const r of uCallers) {
    const label = `${r.name}()`;
    // disambiguate duplicates: if two symbols same name, keep id mapping first
    if (!labelToId.has(label)) labelToId.set(label, r.id);
    else {
      // make unique label with location suffix to avoid mermaid collision but keep map
      const alt = `${r.name}() ${r.location.split('/').pop()}`;
      labelToId.set(alt, r.id);
      lines.push(`  ${idOf(r.id)}(["${esc(alt)}"])`);
      continue;
    }
    lines.push(`  ${idOf(r.id)}(["${esc(label)}"])`);
  }
  lines.push(`  ${selId}(["${esc(selLabel)}"])`);
  for (const r of uCallees) {
    const label = `${r.name}()`;
    if (!labelToId.has(label)) labelToId.set(label, r.id);
    else {
      const alt = `${r.name}() ${r.location.split('/').pop()}`;
      labelToId.set(alt, r.id);
      lines.push(`  ${idOf(r.id)}(["${esc(alt)}"])`);
      continue;
    }
    lines.push(`  ${idOf(r.id)}(["${esc(label)}"])`);
  }

  lines.push('');
  for (const r of uCallers) lines.push(`  ${idOf(r.id)} --> ${selId}`);
  for (const r of uCallees) lines.push(`  ${selId} --> ${idOf(r.id)}`);

  lines.push('');
  for (const r of uCallers) lines.push(`  ${idOf(r.id)}:::caller`);
  lines.push(`  ${selId}:::center`);
  for (const r of uCallees) lines.push(`  ${idOf(r.id)}:::callee`);

  return { code: lines.join('\n'), labelToId };
}

export default function SymbolDepsView({
  symbolId,
  onNavigate,
}: {
  symbolId: string;
  onNavigate: (id: string) => void;
}) {
  const [data, setData] = useState<{ symbol: Sym; callers: Rel[]; callees: Rel[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { viewportRef, canvasRef, scale, offset, zoomBy, fit, inject, viewportProps } = useZoomPan();
  const labelMapRef = useRef<Map<string,string>>(new Map());

  useEffect(() => {
    setData(null);
    setError(null);
    fetch(`/api/symbol?id=${encodeURIComponent(symbolId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch(() => setError('Could not load symbol dependencies.'));
  }, [symbolId]);

  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const { symbol, callers, callees } = data;
    if (callers.length === 0 && callees.length === 0) return;
    const { code, labelToId } = symbolDepsToMermaid(symbol, callers, callees);
    // keep map for click handler
    labelMapRef.current.clear();
    for (const [k,v] of labelToId) labelMapRef.current.set(k, v);
    let cancelled = false;
    renderMermaid('symdep', code)
      .then((svg) => {
        if (cancelled || !canvasRef.current) return;
        inject(svg);
        wireNodeClicks(canvasRef.current!, (label) => {
          const id = labelMapRef.current.get(label) ?? [...labelMapRef.current.entries()].find(([l])=> l===label)?.[1];
          if (id) onNavigate(id);
        });
      })
      .catch((e) => {
        console.error('mermaid render failed:', e, '\ncode:\n', code);
        setError('Could not render the graph.');
      });
    return () => { cancelled = true; };
  }, [data, canvasRef, inject, labelMapRef, onNavigate]);

  const copyCode = () => {
    if (!data) return;
    const { code } = symbolDepsToMermaid(data.symbol, data.callers, data.callees);
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const empty = data && data.callers.length === 0 && data.callees.length === 0;

  return (
    <>
      <div className="code-header">
        <div className="code-breadcrumb">
          <span className="current">{data?.symbol.name ?? symbolId.slice(symbolId.lastIndexOf(':')+1)} — Dependencies</span>
          {data && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-3)' }}>{data.symbol.fileId}:{data.symbol.startLine}</span>}
        </div>
      </div>
      {error ? (
        <div className="center-empty"><div className="empty-card"><div className="empty-desc">{error}</div></div></div>
      ) : !data ? (
        <div className="center-empty"><div className="empty-card"><div className="empty-title">Loading…</div></div></div>
      ) : empty ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-title">No symbol dependencies</div>
            <div className="empty-desc">This symbol has no indexed callers or callees. Call graph is built only from indexed symbols.</div>
          </div>
        </div>
      ) : (
        <div className="deps-viewport" ref={viewportRef} {...viewportProps}>
          <div
            className="deps-canvas"
            ref={canvasRef}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          />
          <div className="graph-actions">
            <div className="zoom-controls">
              <button title="Copy Mermaid" onClick={copyCode}>
                {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
              </button>
              <button title="Zoom in" onClick={() => zoomBy(1.2)}><Plus size={14} strokeWidth={2} /></button>
              <button title="Fit" onClick={fit}><Maximize2 size={13} strokeWidth={2} /></button>
              <button title="Zoom out" onClick={() => zoomBy(1/1.2)}><Minus size={14} strokeWidth={2} /></button>
              <span className="zoom-label">{Math.round(scale*100)}%</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
