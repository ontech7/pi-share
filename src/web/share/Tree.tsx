import clsx from 'clsx';
import { ChevronRight, Folder } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ShareMeta } from '../../shared/api.ts';
import { formatBytes } from '../lib/format.ts';
import { useI18n } from '../lib/i18n-context.tsx';
import type { DownloadState } from './downloads.ts';
import { FileRow } from './FileRow.tsx';

type Entry = ShareMeta['entries'][number];
type FolderNode = { name: string; path: string; folders: FolderNode[]; files: Entry[]; size: number; count: number };

const PAGE = 100;
const INDENT = 20;

function buildTree(entries: Entry[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], files: [], size: 0, count: 0 };
  const index = new Map<string, FolderNode>([['', root]]);
  for (const entry of entries) {
    const segments = entry.path.split('/');
    let parent = root;
    parent.size += entry.size;
    parent.count++;
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const path = segments.slice(0, depth + 1).join('/');
      let folder = index.get(path);
      if (!folder) {
        folder = { name: segments[depth] as string, path, folders: [], files: [], size: 0, count: 0 };
        index.set(path, folder);
        parent.folders.push(folder);
      }
      folder.size += entry.size;
      folder.count++;
      parent = folder;
    }
    parent.files.push(entry);
  }
  return root;
}

type Props = {
  entries: Entry[];
  ready: boolean;
  states: Record<string, DownloadState>;
  onDownload: (entry: Entry) => void;
};

/** Folders render their content only once opened, so a share with thousands of files stays light. */
export function Tree({ entries, ready, states, onDownload }: Props) {
  const root = useMemo(() => buildTree(entries), [entries]);
  const single = root.files.length === 0 && root.folders.length === 1 ? root.folders[0] : undefined;
  const [open, setOpen] = useState(() => new Set(single ? [single.path] : []));
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <FolderContent
      node={root}
      depth={0}
      open={open}
      onToggle={toggle}
      ready={ready}
      states={states}
      onDownload={onDownload}
    />
  );
}

type ContentProps = Omit<Props, 'entries'> & {
  node: FolderNode;
  depth: number;
  open: Set<string>;
  onToggle: (path: string) => void;
};

function FolderContent({ node, depth, open, onToggle, ready, states, onDownload }: ContentProps) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(PAGE);
  const children = [...node.folders.map((folder) => ({ folder })), ...node.files.map((file) => ({ file }))];
  const idle = { status: 'idle' } as const;

  return (
    <>
      {children.slice(0, limit).map((child) =>
        'folder' in child ? (
          <FolderRow
            key={`d:${child.folder.path}`}
            node={child.folder}
            depth={depth}
            open={open}
            onToggle={onToggle}
            ready={ready}
            states={states}
            onDownload={onDownload}
          />
        ) : (
          <div key={child.file.id} style={{ paddingLeft: depth * INDENT }}>
            <FileRow
              name={child.file.path.split('/').at(-1) as string}
              size={child.file.size}
              available={ready}
              state={states[child.file.id] ?? idle}
              onDownload={() => onDownload(child.file)}
            />
          </div>
        ),
      )}
      {children.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((current) => current + PAGE * 5)}
          style={{ paddingLeft: depth * INDENT + 20 }}
          className="press w-full py-3 text-left text-sm font-medium text-accent-strong hover:bg-surface-2"
        >
          {t('share.showMore', { n: children.length - limit })}
        </button>
      )}
    </>
  );
}

function FolderRow(props: ContentProps) {
  const { node, depth, open, onToggle } = props;
  const { t, lang } = useI18n();
  const expanded = open.has(node.path);
  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(node.path)}
        style={{ paddingLeft: depth * INDENT + 16 }}
        className="flex w-full items-center gap-3 py-3 pr-4 text-left transition-colors hover:bg-surface-2 sm:pr-5"
      >
        <ChevronRight
          className={clsx('size-4 shrink-0 text-muted transition-transform duration-200', expanded && 'rotate-90')}
        />
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent-strong">
          <Folder className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium" title={node.name}>
            {node.name}
          </span>
          <span className="block text-xs text-muted tabular">
            {t('share.files', { n: node.count })} · {formatBytes(node.size, lang)}
          </span>
        </span>
      </button>
      {expanded && <FolderContent {...props} depth={depth + 1} />}
    </>
  );
}
