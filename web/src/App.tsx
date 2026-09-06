import { useCallback, useEffect, useRef, useState } from 'react';
import { Layers, X, RefreshCw, Network, Activity, Globe2, Settings, BookOpen, Search } from 'lucide-react';
import Sidebar from './Sidebar';
import CodeView from './CodeView';
import Inspector from './Inspector';
import DepsView from './DepsView';
import OverviewView from './components/OverviewView';
import ContextView from './components/ContextView';
import BriefView from './components/BriefView';
import TraceView from './TraceView';
import SettingsModal from './components/SettingsModal';
import SearchModal from './components/SearchModal';
import FileIconFor from './components/FileIcon';
import type { RepoInfo, TreeNode } from './types';

const LANG_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export const OVERVIEW_PATH = '@overview';
export const TRACE_PREFIX = '@trace:';
export const CONTEXT_PATH = '@context';
export const BRIEF_PATH = '@brief';

export default function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<TreeNode | null>(null);
  const [tabs, setTabs] = useState<TreeNode[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  const [symbolId, setSymbolId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<Record<string, 'code' | 'deps'>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [fresh, setFresh] = useState(true);
  const [dataTick, setDataTick] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [hasAiKey, setHasAiKey] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const resizing = useRef<'left' | 'right' | null>(null);
  const restored = useRef(false);
  const restoredEmpty = useRef(true);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('archi-ui');
      if (saved) {
        const s = JSON.parse(saved);
        if (Array.isArray(s.tabs)) setTabs(s.tabs);
        if (s.openFile) setOpenFile(s.openFile);
        if (s.viewMode) setViewMode(s.viewMode);
        if (typeof s.symbolId === 'string') setSymbolId(s.symbolId);
        restoredEmpty.current = !s.tabs || s.tabs.length === 0;
      }
    } catch {
      /* ignore */
    }
    restored.current = true;
  }, []);

  // L0: open Repository Brief by default on a fresh session (no restored tabs)
  useEffect(() => {
    if (!restored.current) return;
    if (!restoredEmpty.current) return;
    if (sessionStorage.getItem('archi-brief-done')) return;
    sessionStorage.setItem('archi-brief-done', '1');
    const briefNode = { name: 'Brief', path: BRIEF_PATH, type: 'file' as const, ext: '' };
    setTabs([briefNode]);
    setOpenFile(briefNode);
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    try {
      sessionStorage.setItem(
        'archi-ui',
        JSON.stringify({ tabs, openFile, viewMode, symbolId })
      );
    } catch {
      /* ignore */
    }
  }, [tabs, openFile, viewMode, symbolId]);

  const refreshIndex = () => {
    setRefreshing(true);
    fetch('/api/index/refresh', { method: 'POST' })
      .then((r) => r.json())
      .then(() => setFresh(true))
      .catch(() => {})
      .finally(() => {
        setRefreshing(false);
        return fetch('/api/tree')
          .then((r) => r.json())
          .then((t) => {
            setTree(t);
            setDataTick((n) => n + 1);
          })
          .catch(() => {});
      });
  };

  useEffect(() => {
    let alive = true;
    const poll = () =>
      fetch('/api/index/fresh')
        .then((r) => r.json())
        .then((d) => alive && setFresh(d.fresh))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    fetch('/api/ai/status')
      .then((r) => r.json())
      .then((d) => setHasAiKey(Boolean(d.hasKey)))
      .catch(() => {});
  }, [dataTick]);

  const navigateSymbol = (id: string) => {
    setSymbolId(id || null);
    if (!id) return;
    const fileId = id.slice(0, id.indexOf(':'));
    if (fileId && openFile && fileId !== openFile.path) {
      const node: TreeNode = {
        name: fileId.split('/').pop() ?? fileId,
        path: fileId,
        type: 'file',
        ext: fileId.slice(fileId.lastIndexOf('.')),
      };
      openInTab(node);
    }
  };

  const startResize = useCallback(
    (side: 'left' | 'right') => (e: React.MouseEvent) => {
      e.preventDefault();
      resizing.current = side;
      const move = (ev: MouseEvent) => {
        if (!resizing.current) return;
        if (resizing.current === 'left') {
          setSidebarWidth(Math.min(Math.max(ev.clientX, 160), window.innerWidth - 380));
        } else {
          setInspectorWidth(Math.min(Math.max(window.innerWidth - ev.clientX, 240), 560));
        }
      };
      const up = () => {
        resizing.current = null;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      document.body.style.cursor = 'col-resize';
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    []
  );

  const openInTab = (node: TreeNode) => {
    setOpenFile(node);
    setTabs((ts) => (ts.some((t) => t.path === node.path) ? ts : [...ts, node]));
  };

  const openPath = (path: string, ext: string) =>
    openInTab({ name: path.split('/').pop() ?? path, path, type: 'file', ext });

  const openTrace = (symId: string, symName: string) => {
    const tracePath = `${TRACE_PREFIX}${symId}`;
    const existing = tabs.find((t) => t.path === tracePath);
    if (existing) {
      setOpenFile(existing);
    } else {
      const node: TreeNode = {
        name: `${symName}()`,
        path: tracePath,
        type: 'file',
        ext: '',
      };
      openInTab(node);
    }
  };

  const mode: 'code' | 'deps' =
    openFile && LANG_EXTS.has(openFile.ext ?? '')
      ? viewMode[openFile.path] ?? 'code'
      : 'code';

  const closeTab = (path: string) => {
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.path === path);
      const next = ts.filter((t) => t.path !== path);
      if (openFile?.path === path) {
        setOpenFile(next[Math.min(idx, next.length - 1)] ?? null);
      }
      return next;
    });
  };

  useEffect(() => {
    fetch('/api/repo')
      .then((r) => r.json())
      .then(setRepo)
      .catch(() => setError('Could not reach the archiviz server.'));
    fetch('/api/tree')
      .then((r) => r.json())
      .then(setTree)
      .catch(() => {});
    fetch('/api/index/fresh')
      .then((r) => r.json())
      .then((d) => { if (typeof d.fresh === 'boolean') setFresh(d.fresh); })
      .catch(() => {});
  }, []);

  // Cmd/Ctrl+K opens search, ? opens help
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch((s) => !s);
      }
      if (e.key === '?' && !(e.metaKey || e.ctrlKey)) {
        setShowHelp((s) => !s);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const exportJson = () => {
    fetch('/api/tree').then((r) => r.json()).then((tree) => {
      Promise.all([fetch('/api/overview').then((r) => r.json()), fetch('/api/context').then((r) => r.json())]).then(([ov, ctx]) => {
        const blob = new Blob([JSON.stringify({ tree, overview: ov, context: ctx }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `${repo?.name ?? 'archi'}-export.json`; a.click(); URL.revokeObjectURL(url);
      });
    });
  };

  const handleSearchSelect = (result: { type: string; name: string; id: string; view: string }) => {
    if (result.view === 'overview') {
      openInTab({ name: 'Overview', path: OVERVIEW_PATH, type: 'file', ext: '' });
    } else if (result.view === 'context') {
      openInTab({ name: 'Context', path: CONTEXT_PATH, type: 'file', ext: '' });
    } else if (result.view === 'trace') {
      // symbol: open the file and select it in inspector
      const colonIdx = result.id.indexOf(':');
      if (colonIdx > 0) {
        const fileId = result.id.slice(0, colonIdx);
        const ext = fileId.slice(fileId.lastIndexOf('.'));
        openInTab({ name: fileId.split('/').pop() ?? fileId, path: fileId, type: 'file', ext });
        setSymbolId(result.id);
      } else {
        openTrace(result.id, result.name);
      }
    } else if (result.view === 'code') {
      const ext = result.id.slice(result.id.lastIndexOf('.'));
      openInTab({ name: result.id.split('/').pop() ?? result.id, path: result.id, type: 'file', ext });
    }
  };

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-brand">
          <Layers size={16} strokeWidth={1.8} />
          Archiviz
        </div>
        {repo && (
          <div className="titlebar-project">
            <strong>{repo.name}</strong>
          </div>
        )}
        <div className="titlebar-spacer" />
        <button
          className="tb-btn search-trigger"
          title="Search (Ctrl+K)"
          onClick={() => setShowSearch(true)}
        >
          <Search size={14} strokeWidth={1.8} />
          <span>Search</span>
        </button>
        <button
          className={`tb-btn${openFile?.path === BRIEF_PATH ? ' active' : ''}`}
          title="Repository brief"
          onClick={() =>
            openInTab({ name: 'Brief', path: BRIEF_PATH, type: 'file', ext: '' })
          }
        >
          <BookOpen size={14} strokeWidth={1.8} />
          <span>Brief</span>
        </button>
        <button
          className={`tb-btn${openFile?.path === CONTEXT_PATH ? ' active' : ''}`}
          title="System context"
          onClick={() =>
            openInTab({
              name: 'Context',
              path: CONTEXT_PATH,
              type: 'file',
              ext: '',
            })
          }
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>Context</span>
        </button>
        <button
          className={`tb-btn${openFile?.path === OVERVIEW_PATH ? ' active' : ''}`}
          title="Component overview"
          onClick={() =>
            openInTab({
              name: 'Overview',
              path: OVERVIEW_PATH,
              type: 'file',
              ext: '',
            })
          }
        >
          <Network size={14} strokeWidth={1.8} />
          <span>Components</span>
        </button>
        <button
          className={`tb-btn${hasAiKey ? ' ai-on' : ''}`}
          title={hasAiKey ? 'AI annotations enabled' : 'Add AI API key'}
          onClick={() => setShowSettings(true)}
        >
          <Settings size={14} strokeWidth={1.8} />
          <span>AI</span>
        </button>
        <button className="tb-btn" title="Export JSON" onClick={exportJson}>Export</button>
        <button className="tb-btn" title="Shortcuts (?)" onClick={() => setShowHelp((s) => !s)}>?</button>
        <button
          className={`tb-btn refresh-pill${fresh ? ' fresh' : ' stale'}`}
          title={fresh ? 'Index up to date' : 'Files changed, click to re-index'}
          onClick={refreshIndex}
          disabled={refreshing}
        >
          <RefreshCw size={13} strokeWidth={1.8} className={refreshing ? 'spin' : ''} />
          <span className="fresh-label">{fresh ? 'Up to date' : 'Click to update'}</span>
        </button>
      </div>

      <div className="app-body">
        {error ? (
          <div className="main">
            <div className="center-empty">
              <div className="empty-card">
                <div className="empty-title">Server unreachable</div>
                <div className="empty-desc">{error}</div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <Sidebar tree={tree} onFileSelect={openInTab} width={sidebarWidth} />
            <div className="resize-handle" onMouseDown={startResize('left')} />
            <div className="main">
              {tabs.length > 0 && (
                <div className="tabbar">
                  {tabs.map((t) => (
                    <div
                      key={t.path}
                      className={`tab${openFile?.path === t.path ? ' active' : ''}`}
                      onClick={() => setOpenFile(t)}
                    >
                      {t.path === BRIEF_PATH ? (
                        <BookOpen size={13} strokeWidth={2} />
                      ) : t.path === OVERVIEW_PATH ? (
                        <Network size={13} strokeWidth={2} />
                      ) : t.path === CONTEXT_PATH ? (
                        <Globe2 size={13} strokeWidth={2} />
                      ) : t.path.startsWith(TRACE_PREFIX) ? (
                        <Activity size={13} strokeWidth={2} />
                      ) : (
                        <FileIconFor node={t} />
                      )}
                      {t.name}
                      <button
                        className="tab-close"
                        title="Close tab"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(t.path);
                        }}
                      >
                        <X size={13} strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {openFile && LANG_EXTS.has(openFile.ext ?? '') && (
                <div className="view-toggle">
                  <button
                    className={mode === 'code' ? 'active' : ''}
                    onClick={() =>
                      setViewMode((m) => ({ ...m, [openFile.path]: 'code' }))
                    }
                  >
                    Code
                  </button>
                  <button
                    className={mode === 'deps' ? 'active' : ''}
                    onClick={() =>
                      setViewMode((m) => ({ ...m, [openFile.path]: 'deps' }))
                    }
                  >
                    Deps
                  </button>
                </div>
              )}
              {openFile?.path === BRIEF_PATH ? (
                <BriefView
                  key={`brief-${dataTick}`}
                  repoName={repo?.name ?? ''}
                  onOpenFile={openPath}
                  onOpenOverview={() =>
                    openInTab({ name: 'Overview', path: OVERVIEW_PATH, type: 'file', ext: '' })
                  }
                  onOpenTrace={openTrace}
                  onOpenContext={() =>
                    openInTab({ name: 'Context', path: CONTEXT_PATH, type: 'file', ext: '' })
                  }
                />
              ) : openFile?.path === OVERVIEW_PATH ? (
                <OverviewView
                  key={`ov-${dataTick}`}
                  repoName={repo?.name ?? ''}
                  onOpenFile={openPath}
                />
              ) : openFile?.path === CONTEXT_PATH ? (
                <ContextView
                  key={`ctx-${dataTick}`}
                  repoName={repo?.name ?? ''}
                  onOpenFile={openPath}
                  onOpenOverview={() =>
                    openInTab({ name: 'Overview', path: OVERVIEW_PATH, type: 'file', ext: '' })
                  }
                />
              ) : openFile?.path.startsWith(TRACE_PREFIX) ? (
                <TraceView
                  key={`trace-${openFile.path}-${dataTick}`}
                  symbolId={openFile.path.slice(TRACE_PREFIX.length)}
                  onOpenFile={openPath}
                />
              ) : openFile ? (
                mode === 'deps' ? (
                  <DepsView
                    key={`deps-${openFile.path}-${dataTick}`}
                    filePath={openFile.path}
                    onOpenFile={openPath}
                  />
                ) : (
                  <CodeView
                    key={`${openFile.path}-${dataTick}`}
                    filePath={openFile.path}
                    ext={openFile.ext}
                    selectedSymbolId={symbolId}
                    onSymbolClick={navigateSymbol}
                  />
                )
              ) : (
                <div className="center-empty">
                  <div className="empty-card">
                    <div className="empty-title">Nothing selected</div>
                    <div className="empty-desc">
                      Pick a file or folder in the sidebar to start exploring.
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="resize-handle" onMouseDown={startResize('right')} />
            <Inspector
              symbolId={openFile && !openFile.path.startsWith('@') ? symbolId : null}
              onNavigate={navigateSymbol}
              onTrace={openTrace}
              width={inspectorWidth}
            />
          </>
        )}
        {showSettings && (
          <SettingsModal
            hasKey={hasAiKey}
            onClose={() => setShowSettings(false)}
            onSaved={() => setDataTick((n) => n + 1)}
          />
        )}
        <SearchModal
          open={showSearch}
          onClose={() => setShowSearch(false)}
          onSelect={handleSearchSelect}
        />
        {showHelp && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setShowHelp(false)}>
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 600, marginBottom: 12 }}>Keyboard shortcuts</div>
              <div style={{ fontSize: 13, lineHeight: '1.8', color: 'var(--text-2)' }}>
                <div><code>Ctrl+K</code> — Search</div>
                <div><code>?</code> — Toggle this help</div>
                <div><code>Click</code> file in tree — open</div>
                <div><code>Click</code> line — inspect symbol</div>
              </div>
              <button className="btn-trace" style={{ marginTop: 16 }} onClick={() => setShowHelp(false)}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
