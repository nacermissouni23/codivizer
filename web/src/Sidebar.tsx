import { useState } from 'react';
import { Folder, FolderOpen } from 'lucide-react';
import FileIconFor from './components/FileIcon';
import type { TreeNode } from './types';

function Row({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (n: TreeNode) => void;
}) {
  const [open, setOpen] = useState(false);

  const isDir = node.type === 'dir';
  const isSelected = selected === node.path;

  return (
    <>
      <div
        className={`tree-row${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => {
          if (isDir) setOpen((o) => !o);
          onSelect(node);
        }}
      >
        {isDir ? (
          <span className="tree-icon folder">
            {open
              ? <FolderOpen size={15} strokeWidth={1.8} />
              : <Folder size={15} strokeWidth={1.8} />}
          </span>
        ) : (
          <FileIconFor node={node} />
        )}
        <span className="tree-label">{node.name}</span>
        {isDir && node.children && (
          <span className="tree-badge">{node.children.length}</span>
        )}
      </div>
      {isDir &&
        open &&
        node.children?.map((c) => (
          <Row
            key={c.path}
            node={c}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

export default function Sidebar({
  tree,
  onFileSelect,
  width,
}: {
  tree: TreeNode | null;
  onFileSelect: (node: TreeNode) => void;
  width: number;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [extFilter, setExtFilter] = useState('');
  const [indexedOnly, setIndexedOnly] = useState(false);

  const filteredTree = (() => {
    if (!tree || (!filter && !extFilter && !indexedOnly)) return tree;
    const needle = filter.toLowerCase();
    const extNeedle = extFilter.toLowerCase().replace(/^\./, '');
    function filterNode(n: TreeNode): TreeNode | null {
      if (n.type === 'file') {
        if (indexedOnly && !n.ext) return null;
        if (extNeedle && (n.ext ?? '').replace(/^\./, '').toLowerCase() !== extNeedle) return null;
        if (needle && !n.name.toLowerCase().includes(needle) && !n.path.toLowerCase().includes(needle)) return null;
        return n;
      }
      const children = (n.children ?? []).map(filterNode).filter(Boolean) as TreeNode[];
      if (children.length === 0 && (needle || extNeedle || indexedOnly)) return null;
      return { ...n, children };
    }
    const children = (tree.children ?? []).map(filterNode).filter(Boolean) as TreeNode[];
    return { ...tree, children };
  })();

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-header">Explorer</div>
      <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6, borderBottom: '1px solid var(--border)' }}>
        <input placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-1)', fontSize: 12 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <input placeholder="ext (ts, py)" value={extFilter} onChange={(e) => setExtFilter(e.target.value)} style={{ flex: 1, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--text-1)', fontSize: 11 }} />
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--text-2)', cursor: 'pointer' }}><input type="checkbox" checked={indexedOnly} onChange={(e) => setIndexedOnly(e.target.checked)} /> indexed</label>
        </div>
      </div>
      <div
        className="sidebar-tree"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
      >
        {!tree && (
          <div className="rel-empty" style={{ padding: 12, color: 'var(--text-3)', fontSize: 12 }}>
            Loading…
          </div>
        )}
        {filteredTree?.children?.map((c) => (
          <Row
            key={c.path}
            node={c}
            depth={0}
            selected={selected}
            onSelect={(n) => {
              setSelected(n.path);
              if (n.type === 'file') onFileSelect(n);
            }}
          />
        ))}
      </div>
    </div>
  );
}
