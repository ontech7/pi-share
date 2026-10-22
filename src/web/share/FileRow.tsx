import clsx from 'clsx';
import {
  ArrowDownToLine,
  BadgeCheck,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  RotateCcw,
} from 'lucide-react';
import { formatBytes } from '../lib/format.ts';
import { useI18n } from '../lib/i18n-context.tsx';
import { Button } from '../ui/Button.tsx';
import { Progress } from '../ui/Progress.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import type { DownloadState } from './downloads.ts';

const KINDS: [RegExp, typeof File][] = [
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i, FileArchive],
  [/\.(png|jpe?g|gif|webp|heic|avif|svg|tiff?)$/i, FileImage],
  [/\.(mp4|mov|mkv|avi|webm|m4v)$/i, FileVideo],
  [/\.(mp3|wav|flac|m4a|ogg|aac)$/i, FileAudio],
  [/\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|odt|rtf)$/i, FileText],
];

type Props = {
  name: string;
  size: number;
  available: boolean;
  state: DownloadState;
  onDownload: () => void;
  highlight?: boolean;
};

export function FileRow({ name, size, available, state, onDownload, highlight }: Props) {
  const { t, lang } = useI18n();
  const Icon = KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? File;
  const progress =
    state.status === 'running' ? (state.total > 0 ? state.loaded / state.total : 0) : state.status === 'done' ? 1 : 0;

  const errorText =
    state.status === 'error'
      ? state.reason === 'integrity' || state.reason === 'format' || state.reason === 'truncated'
        ? t('share.integrity')
        : state.reason === 'busy'
          ? t('share.busy')
          : t('share.failed')
      : null;

  return (
    <div className={clsx('flex flex-col gap-2.5 px-4 py-3.5 sm:px-5', !available && 'opacity-60')}>
      <div className="flex items-center gap-3">
        <span
          className={clsx(
            'grid size-10 shrink-0 place-items-center rounded-xl',
            highlight ? 'bg-accent text-on-accent' : 'bg-surface-2 text-accent-strong',
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium" title={name}>
            {name}
          </p>
          <p className="text-xs text-muted tabular">
            {available ? formatBytes(size, lang) : t('share.fileUnavailable')}
            {state.status === 'running' && ` · ${Math.floor(progress * 100)}%`}
          </p>
        </div>
        {available && (
          <div className="shrink-0">
            {state.status === 'idle' && (
              <Button
                size="sm"
                variant={highlight ? 'primary' : 'secondary'}
                icon={<ArrowDownToLine className="size-4" />}
                onClick={onDownload}
              >
                {highlight ? t('share.downloadAll') : t('share.download')}
              </Button>
            )}
            {(state.status === 'starting' || state.status === 'running') && (
              <Spinner className="m-2 size-5 text-accent-strong" />
            )}
            {state.status === 'done' && (
              <span className="flex animate-pop items-center gap-1.5 text-sm font-medium text-ok">
                <BadgeCheck className="size-5" />
                <span className="max-sm:sr-only">{t('share.verified')}</span>
              </span>
            )}
            {state.status === 'error' && (
              <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} onClick={onDownload}>
                {t('common.retry')}
              </Button>
            )}
          </div>
        )}
      </div>
      {(state.status === 'running' || state.status === 'starting') && <Progress value={progress} />}
      {errorText && (
        <p className="animate-enter text-sm text-danger" role="alert">
          {errorText}
        </p>
      )}
    </div>
  );
}
