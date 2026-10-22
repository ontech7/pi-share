const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Four groups of four from an unambiguous alphabet: about 79 bits, easy to dictate. */
export function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const chars: string[] = [];
  for (const byte of bytes) {
    if (byte >= 248) continue;
    chars.push(ALPHABET[byte % ALPHABET.length] as string);
    if (chars.length === 16) break;
  }
  return (chars.join('').match(/.{4}/g) ?? []).join('-');
}
