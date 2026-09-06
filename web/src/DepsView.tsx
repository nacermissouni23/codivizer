import { useEffect, useState } from 'react';
import type { DepsResponse } from './lib/depsMermaid';
import { depsToMermaid } from './lib/depsMermaid';
import { renderMermaid, wireNodeClicks } from './lib/mermaidInit';
import { useZoomPan } from './lib/useZoomPan';
import { Copy, Check } from 'lucide-react';

export default function DepsView({
  filePath,
  onOpenFile,
}: {
  filePath: string;
  onOpenFile: (path: string, ext: string) => void;
}) {
  const [deps, setDeps] = useState<DepsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { viewportRef, canvasRef, scale, offset, zoomBy, fit, inject, viewportProps } =
    useZoomPan();

  useEffect(() => {
    setDeps(null);
    setError(null);
    fetch(`/api/deps?file=${encodeURIComponent(filePath)}`)
      .then((r) => r.json())
      .then(setDeps)
      .catch(() => setError('Could not load dependencies.'));
  }, [filePath]);

  useEffect(() => {
    if (!deps || !canvasRef.current) return;
    if (deps.dependencies.length === 0 && deps.dependents.length === 0) return;
    const code = depsToMermaid(deps);
    let cancelled = false;
    renderMermaid('deps', code)
      .then((svg) => {
        if (cancelled || !canvasRef.current) return;
        inject(svg);
        wireNodeClicks(canvasRef.current!, (label) => {
          const all = [...deps.dependencies, ...deps.dependents];
          const hit = all.find((d) => d.name === label);
          if (hit) {
            const ext = hit.id.slice(hit.id.lastIndexOf('.'));
            onOpenFile(hit.id, ext);
          }
        });
      })
      .catch((e) => {
        console.error('mermaid render failed:', e, '\ncode:\n', code);
        setError('Could not render the graph.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps]);

  const copyCode = () => {
    if (!deps) return;
    navigator.clipboard.writeText(depsToMermaid(deps)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const empty = deps && deps.dependencies.length === 0 && deps.dependents.length === 0;

  return (
    <>
      <div className="code-header">
        <div className="code-breadcrumb">
          {filePath.split('/').map((seg, i, arr) => (
            <span key={i}>
              {i > 0 && <span className="sep">&nbsp;/&nbsp;</span>}
              <span className={i === arr.length - 1 ? 'current' : ''}>{seg}</span>
            </span>
          ))}
        </div>
      </div>
      {error ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-desc">{error}</div>
          </div>
        </div>
      ) : empty ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-title">No indexed imports</div>
            <div className="empty-desc">
              This file doesn't import any indexed file and isn't imported by one.
            </div>
          </div>
        </div>
      ) : (
        <div className="deps-viewport" ref={viewportRef} {...viewportProps}>
          <div
            className="deps-canvas"
            ref={canvasRef}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            }}
          />
          <div className="graph-actions">
            <div className="zoom-controls">
              {deps && !empty && (
                <button title="Copy Mermaid" onClick={copyCode}>
                  {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
                </button>
              )}
              <button title="Zoom in" onClick={() => zoomBy(1.2)}>
                +
              </button>
              <button title="Fit" onClick={fit}>
                ⤢
              </button>
              <button title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
                −
              </button>
              <span className="zoom-label">{Math.round(scale * 100)}%</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
