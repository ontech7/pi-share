import { describe, expect, it } from 'vitest';
import { splitExtension, splitForEllipsis } from '../src/web/lib/filename.ts';

describe('file names cut in the middle', () => {
  it('keep the end of the name and the extension in the tail', () => {
    const name = 'file con nome lunghissimo che finisce qui.zip';
    const { head, tail } = splitForEllipsis(name);
    expect(tail).toBe('ce qui.zip');
    expect(head + tail).toBe(name);
  });

  it('leave short names whole in the tail, so they never get an ellipsis', () => {
    expect(splitForEllipsis('a.pdf')).toEqual({ head: '', tail: 'a.pdf' });
    expect(splitForEllipsis('Foto')).toEqual({ head: '', tail: 'Foto' });
  });

  it('start the tail on a word, not on the space before it', () => {
    expect(splitForEllipsis('Smoke test for one line on a phone.zip')).toEqual({
      head: 'Smoke test for one line on a ',
      tail: 'phone.zip',
    });
  });

  it('cut names without an extension too, such as folders', () => {
    expect(splitForEllipsis('Vacanze in Sardegna 2026')).toEqual({ head: 'Vacanze in Sardegn', tail: 'a 2026' });
  });

  it('never split an emoji', () => {
    const { head, tail } = splitForEllipsis('ricordi al mare 🏖️🏖️🏖️.jpg');
    expect(head + tail).toBe('ricordi al mare 🏖️🏖️🏖️.jpg');
    expect(tail).toBe('re 🏖️🏖️🏖️.jpg');
  });

  it('find the extension, without mistaking dotfiles, spaces or long tails for one', () => {
    expect(splitExtension('backup.tar.gz')).toEqual({ stem: 'backup', extension: '.tar.gz' });
    expect(splitExtension('report.final.PDF')).toEqual({ stem: 'report.final', extension: '.PDF' });
    expect(splitExtension('.bashrc')).toEqual({ stem: '.bashrc', extension: '' });
    expect(splitExtension('v. 2 final')).toEqual({ stem: 'v. 2 final', extension: '' });
    expect(splitExtension('name.averyveryverylongtail')).toEqual({ stem: 'name.averyveryverylongtail', extension: '' });
    expect(splitExtension('trailing.')).toEqual({ stem: 'trailing.', extension: '' });
  });
});
