import { Fragment, type ReactNode } from 'react';

/** The small Markdown subset release notes use (headings, bullets, `code`, **bold**), rendered as text nodes only. */
export function ReleaseNotes({ markdown }: { markdown: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  let inCode = false;

  const flush = () => {
    if (!items.length) return;
    blocks.push(
      <ul key={`list-${blocks.length}`} className="ml-4 list-disc space-y-1">
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
          <li key={index}>{inline(item)}</li>
        ))}
      </ul>,
    );
    items = [];
  };

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (line.startsWith('- ')) {
      items.push(line.slice(2));
      continue;
    }
    flush();
    if (line.startsWith('#')) {
      blocks.push(
        <h4 key={`h-${blocks.length}`} className="mt-3 text-xs font-semibold tracking-wide text-muted uppercase">
          {line.replace(/^#+\s*/, '')}
        </h4>,
      );
    } else if (line.trim()) {
      blocks.push(<p key={`p-${blocks.length}`}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="flex flex-col gap-1.5 text-sm leading-relaxed">{blocks}</div>;
}

function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    // biome-ignore lint/suspicious/noArrayIndexKey: static text, never reordered
    const key = index;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return (
        <code key={key} className="rounded bg-surface-2 px-1 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}
