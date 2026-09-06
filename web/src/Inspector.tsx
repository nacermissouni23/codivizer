import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';

interface Sym {
  id: string;
  kind: 'class' | 'function' | 'method';
  name: string;
  fileId: string;
  startLine: number;
  endLine: number;
  signature: string;
  parent?: string;
  async?: boolean;
}

interface Rel {
  id: string;
  name: string;
  location: string;
}

export default function Inspector({
  symbolId,
  onNavigate,
  onTrace,
  width,
}: {
  symbolId: string | null;
  onNavigate: (id: string) => void;
  onTrace: (symId: string, symName: string) => void;
  width: number;
}) {
  const [data, setData] = useState<{ symbol: Sym; callers: Rel[]; callees: Rel[] } | null>(
    null
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    setData(null);
    setError(false);
    if (!symbolId) return;
    fetch(`/api/symbol?id=${encodeURIComponent(symbolId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(true);
        else setData(d);
      })
      .catch(() => setError(true));
  }, [symbolId]);

  const relItem = (r: Rel) => (
    <div key={r.id} className="rel-item" onClick={() => onNavigate(r.id)}>
      <span className="rel-item-kind function" />
      <span className="rel-item-name">{r.name}</span>
      <span className="rel-item-loc">{r.location.split('/').pop()}</span>
    </div>
  );

  return (
    <div className="inspector" style={{ width }}>
      <div className="inspector-header">Inspector</div>
      {!symbolId || error ? (
        <div className="inspector-empty">
          <div>
            <div className="inspector-empty-title">Nothing selected</div>
            <div className="inspector-empty-desc">
              Click a line of code or a symbol chip to see its definition, callers,
              and calls here.
            </div>
          </div>
        </div>
      ) : !data ? (
        <div className="inspector-empty">
          <div className="inspector-empty-title">Loading…</div>
        </div>
      ) : (
        <div className="inspector-content">
          <span className={`symbol-kind-badge ${data.symbol.kind}`}>
            <span className="kind-dot" />
            {data.symbol.kind}
          </span>
          <div className="symbol-name">{data.symbol.name}</div>
          <div
            className="symbol-location"
            title="Jump to source"
            onClick={() =>
              onNavigate(data.symbol.id)
            }
          >
            {data.symbol.fileId}:{data.symbol.startLine}
          </div>
          <div className="symbol-signature">
            {data.symbol.async && <span style={{ color: '#d489c2' }}>async </span>}
            {data.symbol.signature}
          </div>
          <button
            className="btn-trace"
            onClick={() => onTrace(data.symbol.id, data.symbol.name)}
          >
            <Activity size={14} strokeWidth={2} />
            Trace flow
          </button>

          <div className="insp-section">
            <div className="insp-section-title">
              <span className="arrow">↑</span> Called by{' '}
              <span className="count">({data.callers.length})</span>
            </div>
            <div className="rel-list">
              {data.callers.length === 0 ? (
                <div className="rel-empty">None found.</div>
              ) : (
                data.callers.map(relItem)
              )}
            </div>
          </div>

          <div className="insp-section">
            <div className="insp-section-title">
              <span className="arrow">↓</span> Calls{' '}
              <span className="count">({data.callees.length})</span>
            </div>
            <div className="rel-list">
              {data.callees.length === 0 ? (
                <div className="rel-empty">None found, no indexed calls.</div>
              ) : (
                data.callees.map(relItem)
              )}
            </div>
          </div>

          <div className="insp-divider" />
          <div className="insp-meta-row">
            <span>Lines</span>
            <span>
              {data.symbol.startLine}–{data.symbol.endLine}
            </span>
          </div>
          {data.symbol.parent && (
            <div className="insp-meta-row">
              <span>Defined in</span>
              <span>{data.symbol.parent.split(':').pop()?.split('.').slice(-1)}</span>
            </div>
          )}
          <div className="insp-meta-row">
            <span>Async</span>
            <span>{data.symbol.async ? 'yes' : 'no'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
