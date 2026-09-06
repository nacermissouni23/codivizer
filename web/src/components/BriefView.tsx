import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Zap, Play, Boxes, Plug } from 'lucide-react';

interface StorySegment {
  text: string;
  ref?: string;
}

interface BriefData {
  name: string;
  description: string;
  systems: {
    name: string;
    kind: string;
    label: string;
    confidence: 'high' | 'medium';
    importFiles: string[];
    envVars: string[];
  }[];
  libraryCount: number;
  topLibraries: { name: string; role?: string }[];
  entryPoints: {
    kind: string;
    label: string;
    file: string;
    boot?: { fn: string; line: number; calls: { name: string; file: string }[] };
  }[];
  flows: { symbolId: string; name: string; file: string; line: number; callCount: number }[];
  components: { id: string; label: string; description?: string; fileCount: number; symbolCount: number }[];
  ai: { pending: boolean; applied: boolean; error?: string };
}

export default function BriefView({
  repoName,
  onOpenFile,
  onOpenOverview,
  onOpenTrace,
  onOpenContext,
}: {
  repoName: string;
  onOpenFile: (path: string, ext: string) => void;
  onOpenOverview: () => void;
  onOpenTrace: (symbolId: string, name: string) => void;
  onOpenContext: () => void;
}) {
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [story, setStory] = useState<{ segments: StorySegment[]; ai: { pending: boolean; applied: boolean } } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);

  const load = useCallback(() => {
    fetch('/api/brief')
      .then((r) => r.json())
      .then(setBrief)
      .catch(() => setError('Could not load the repository brief.'));
    fetch('/api/story')
      .then((r) => r.json())
      .then(setStory)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // poll while AI is annotating; render immediately regardless
  useEffect(() => {
    if (!brief?.ai.pending && !story?.ai.pending) return;
    const t = setTimeout(() => {
      tick.current += 1;
      load();
    }, 3000);
    return () => clearTimeout(t);
  }, [brief?.ai.pending, story?.ai.pending, load]);

  const openRef = (ref: string) => {
    const [kind, ...rest] = ref.split(':');
    const val = rest.join(':');
    if (kind === 'file') openFileFrom(val);
    else if (kind === 'component') onOpenOverview();
    else if (kind === 'system' || kind === 'actor') onOpenContext();
  };

  const openFileFrom = (f: string) => onOpenFile(f, f.slice(f.lastIndexOf('.')));

  const empty = brief && brief.components.length === 0 && brief.entryPoints.length === 0;

  return (
    <>
      <div className="code-header">
        <div className="code-breadcrumb">
          <span className="current">{repoName} - Repository Brief</span>
          {brief?.ai.applied && <span className="ai-badge">AI annotated</span>}
          {brief?.ai.pending && <span className="ai-badge pending">AI annotating…</span>}
          {brief?.ai.error && !brief?.ai.pending && !brief?.ai.applied && <span className="ai-badge error" title={brief.ai.error}>AI failed: {brief.ai.error}</span>}
        </div>
      </div>
      {error ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-desc">{error}</div>
          </div>
        </div>
      ) : !brief ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-desc">Loading…</div>
          </div>
        </div>
      ) : empty ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-title">Nothing indexed</div>
            <div className="empty-desc">No files found for this repository.</div>
          </div>
        </div>
      ) : (
        <div className="brief-scroll">
          <div className="brief">
            <h1 className="brief-title">{brief.name}</h1>
            {brief.description && <p className="brief-desc">{brief.description}</p>}

            {story && story.segments.length > 0 && (
              <section className="brief-section">
                <div className="brief-section-title">
                  How it works
                  {story.ai.applied && <span className="ai-badge">AI</span>}
                </div>
                <p className="story">
                  {story.segments.map((seg, i) =>
                    seg.ref ? (
                      <span
                        key={i}
                        className="story-link mono"
                        title={seg.ref}
                        onClick={() => openRef(seg.ref!)}
                      >
                        {seg.text}
                      </span>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    )
                  )}
                </p>
              </section>
            )}

            {(brief.systems.length > 0 || brief.topLibraries.length > 0) && (
              <section className="brief-section">
                <div className="brief-section-title">
                  <Plug size={12} strokeWidth={2} /> Built with
                </div>
                <div className="brief-chips">
                  {brief.systems.map((s) => (
                    <span key={s.name} className="brief-chip sys" title={s.kind}>
                      {s.label}
                    </span>
                  ))}
                  {brief.topLibraries.map((l) => (
                    <span key={l.name} className="brief-chip mono" title={l.role}>
                      {l.name}
                      {l.role && <span className="brief-chip-role">: {l.role}</span>}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {brief.entryPoints.length > 0 && (
              <section className="brief-section">
                <div className="brief-section-title">
                  <Play size={12} strokeWidth={2} /> How it starts
                </div>
                {brief.entryPoints.map((ep) => (
                  <div key={ep.file} className="brief-entry">
                    <div className="brief-row" onClick={() => openFileFrom(ep.file)}>
                      <span className="brief-row-label">{ep.label}</span>
                      <span className="brief-row-file">{ep.file}</span>
                    </div>
                    {ep.boot && (
                      <div className="brief-boot">
                        <span className="brief-boot-fn mono" onClick={() => openFileFrom(ep.file)}>
                          {ep.boot.fn}()
                        </span>
                        {ep.boot.calls.map((c) => (
                          <span key={c.name + c.file} className="brief-boot-call" title={c.file}>
                            <span className="mono">{c.name}()</span>
                            <span className="brief-boot-file">{c.file.split('/').pop()}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}

            {brief.components.length > 0 && (
              <section className="brief-section">
                <div className="brief-section-title">
                  <Boxes size={12} strokeWidth={2} /> Major components
                </div>
                {brief.components.map((c) => (
                  <div
                    key={c.id}
                    className="brief-row"
                    onClick={onOpenOverview}
                    title="Open Component Overview"
                  >
                    <span className="brief-row-label">
                      {c.description ? `${c.label} - ${c.description}` : c.label}
                    </span>
                    <span className="brief-row-file">
                      {c.fileCount} files · {c.symbolCount} symbols
                    </span>
                  </div>
                ))}
              </section>
            )}

            {brief.flows.length > 0 && (
              <section className="brief-section">
                <div className="brief-section-title">
                  <Zap size={12} strokeWidth={2} /> Important flows
                </div>
                {brief.flows.map((f) => (
                  <div
                    key={f.symbolId}
                    className="brief-row"
                    onClick={() => onOpenTrace(f.symbolId, f.name)}
                    title="Trace execution flow"
                  >
                    <span className="brief-row-label mono">
                      {f.name}()
                    </span>
                    <span className="brief-row-file">
                      {f.file}:{f.line} · {f.callCount} calls
                    </span>
                  </div>
                ))}
              </section>
            )}

            <button className="brief-explore" onClick={onOpenOverview}>
              Explore architecture <ArrowRight size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
