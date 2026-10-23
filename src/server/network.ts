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

/** An IPv4 client as Node reports it on a dual-stack socket ("::ffff:1.2.3.4") written as plain IPv4. */
export function plainAddress(ip: string | null | undefined): string {
  return (ip ?? '').replace(/^::ffff:(?=\d+\.)/i, '');
}

/** False for anything that is not an address, so a missing or garbled client IP never passes a list. */
export function isAllowed(list: net.BlockList, ip: string | null | undefined): boolean {
  const plain = plainAddress(ip);
  const type = net.isIP(plain);
  return type !== 0 && list.check(plain, type === 6 ? 'ipv6' : 'ipv4');
}
