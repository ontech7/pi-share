import clsx from 'clsx';
import { splitForEllipsis } from '../lib/filename.ts';

/** `title` replaces the tooltip, such as with the full path; `null` leaves it to the parent. */
type Props = { name: string; className?: string; title?: string | null };

/**
 * A file or folder name that, when too long, loses its middle rather than its end, so the extension stays
 * readable. The full name is in the tooltip and is what screen readers hear.
 */
export function FileName({ name, className, title = name }: Props) {
  const { head, tail } = splitForEllipsis(name);
  return (
    <span className={clsx('flex min-w-0', className)} title={title ?? undefined}>
      <span className="sr-only">{name}</span>
      {/* whitespace-pre keeps a space at the cut, which flex items would otherwise drop */}
      <span aria-hidden="true" className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">
        {head}
      </span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">
        {tail}
      </span>
    </span>
  );
}
