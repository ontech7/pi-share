const KEEP = 6;
const MAX_EXTENSION = 10;
const COMPOUND = /\.tar\.(gz|bz2|xz|zst|lz4?)$/i;
const graphemes =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

const charsOf = (text: string) =>
  graphemes ? Array.from(graphemes.segment(text), ({ segment }) => segment) : Array.from(text);

/** The stem and the extension of a file name, with the dot. Dotfiles and folders have none. */
export function splitExtension(name: string): { stem: string; extension: string } {
  const compound = COMPOUND.exec(name);
  if (compound && compound.index > 0) return { stem: name.slice(0, compound.index), extension: compound[0] };
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  if (extension.length < 2 || extension.length > MAX_EXTENSION + 1 || /\s/.test(extension)) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, dot), extension };
}

/**
 * A name cut in two: the head shrinks with an ellipsis when there is no room, the tail (the end of the name and
 * its extension) always stays visible, so "a very long name that ends here.zip" reads "a very lo…s here.zip".
 * Cuts between graphemes, so an emoji or an accented letter is never split in half.
 */
export function splitForEllipsis(name: string): { head: string; tail: string } {
  const { stem, extension } = splitExtension(name);
  const chars = charsOf(stem);
  if (chars.length <= KEEP) return { head: '', tail: name };
  // A space at the cut goes to the head: hidden with it when cut, so the ellipsis never floats before a gap.
  let cut = chars.length - KEEP;
  while (cut < chars.length - 1 && /^\s$/.test(chars[cut] as string)) cut++;
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') + extension };
}
