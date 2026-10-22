import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ChevronRight, File, Folder, HardDrive } from 'lucide-react';
import type { BrowseEntry } from '../../../shared/api.ts';
import { formatBytes, formatDate } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n-context.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { ApiError, api, keys } from '../api.ts';

type Props = {
  path: string;
  onNavigate: (path: string) => void;
  selected: Map<string, BrowseEntry>;
  onToggle: (entry: BrowseEntry) => void;
};

export function FilePicker({ path, onNavigate, selected, onToggle }: Props) {
  const { t, lang } = useI18n();
  const listing = useQuery({
    queryKey: keys.browse(path),
    queryFn: () => api.browse(path),
    placeholderData: (previous) => previous,
  });
  const crumbs = path ? path.split('/') : [];

  return (
    <div className="flex flex-col gap-3">
      <nav className="flex min-h-9 flex-wrap items-center gap-1 text-sm" aria-label="breadcrumb">
        <button
          type="button"
          onClick={() => onNavigate('')}
          className="press flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium text-muted hover:bg-surface-2 hover:text-fg"
        >
          <HardDrive className="size-4" />
          {t('create.root')}
        </button>
        {crumbs.map((crumb, index) => (
          <span key={crumbs.slice(0, index + 1).join('/')} className="flex items-center gap-1">
            <ChevronRight className="size-4 text-muted/60" />
            <button
              type="button"
              onClick={() => onNavigate(crumbs.slice(0, index + 1).join('/'))}
              className={clsx(
                'press max-w-48 truncate rounded-lg px-2 py-1 hover:bg-surface-2',
                index === crumbs.length - 1 ? 'font-semibold text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {crumb}
            </button>
          </span>
        ))}
        {listing.isFetching && <Spinner className="ml-1 text-muted" />}
      </nav>
      <p className="-mt-1 text-xs text-muted">{t('create.folderHint')}</p>

      <div className="overflow-hidden rounded-2xl border border-line">
        {listing.isError ? (
          <p className="p-6 text-sm text-danger">
            {listing.error instanceof ApiError && listing.error.code === 'unreadable'
              ? t('create.unreadable')
              : t('common.error')}
          </p>
        ) : !listing.data ? (
          <div className="grid h-48 place-items-center text-muted">
            <Spinner className="size-5" />
          </div>
        ) : listing.data.entries.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">{t('create.emptyFolder')}</p>
        ) : (
          <ul className="max-h-[46dvh] divide-y divide-line overflow-y-auto overscroll-contain">
            {listing.data.entries.map((entry) => {
              const included = covered(selected, entry.path);
              const isSelected = included || selected.has(entry.path);
              const box = (
                <span
                  className={clsx(
                    'grid size-5 shrink-0 place-items-center rounded-md border transition-colors',
                    isSelected ? 'border-transparent bg-accent text-on-accent' : 'border-line',
                    included && 'opacity-50',
                  )}
                >
                  {isSelected ? (
                    <Check className="size-3.5 animate-pop" strokeWidth={3} />
                  ) : (
                    entry.type === 'file' && <File className="size-3 text-muted" />
                  )}
                </span>
              );
              const meta =
                entry.type === 'file' ? (
                  <span className="shrink-0 text-right text-xs text-muted tabular">
                    {formatBytes(entry.size, lang)}
                    <span className="hidden sm:inline"> · {formatDate(entry.modifiedAt, lang)}</span>
                  </span>
                ) : (
                  <ChevronRight className="size-4 shrink-0 text-muted" />
                );
              const rowClass = clsx('transition-colors', isSelected ? 'bg-accent/12' : 'hover:bg-surface-2');

              if (entry.type === 'file') {
                return (
                  <li key={entry.path} className={rowClass}>
                    <button
                      type="button"
                      disabled={included}
                      title={included ? t('create.included') : undefined}
                      onClick={() => onToggle(entry)}
                      aria-pressed={isSelected}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left"
                    >
                      {box}
                      <span className="min-w-0 flex-1 truncate text-[15px]">{entry.name}</span>
                      {meta}
                    </button>
                  </li>
                );
              }
              return (
                <li key={entry.path} className={clsx(rowClass, 'flex items-stretch')}>
                  <button
                    type="button"
                    disabled={included}
                    title={included ? t('create.included') : undefined}
                    onClick={() => onToggle(entry)}
                    aria-pressed={isSelected}
                    aria-label={`${t('create.folder')} ${entry.name}`}
                    className="press grid shrink-0 place-items-center py-3 pr-2 pl-4"
                  >
                    {box}
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-4 pl-1 text-left"
                  >
                    <Folder className="size-5 shrink-0 text-accent-strong" />
                    <span className="min-w-0 flex-1 truncate text-[15px]">{entry.name}</span>
                    {meta}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Whether a path sits inside a folder that is already selected as a whole. */
function covered(selected: Map<string, BrowseEntry>, path: string): boolean {
  for (const [selectedPath, entry] of selected) {
    if (entry.type === 'dir' && path.startsWith(`${selectedPath}/`)) return true;
  }
  return false;
}
