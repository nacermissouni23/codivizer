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

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-header">Explorer</div>
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
        {tree?.children?.map((c) => (
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
