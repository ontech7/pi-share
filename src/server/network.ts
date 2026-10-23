import net from 'node:net';

export function allowList(cidrs: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [address = '', prefix] = cidr.split('/');
    const type = net.isIPv6(address) ? 'ipv6' : 'ipv4';
    list.addSubnet(address, Number(prefix ?? (type === 'ipv6' ? 128 : 32)), type);
  }
  return list;
}

/** False for anything that is not an address, so a missing or garbled client IP never passes a list. */
export function isAllowed(list: net.BlockList, ip: string | null | undefined): boolean {
  const plain = (ip ?? '').replace(/^::ffff:(?=\d+\.)/i, '');
  const type = net.isIP(plain);
  return type !== 0 && list.check(plain, type === 6 ? 'ipv6' : 'ipv4');
}
