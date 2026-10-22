# Security policy

pi-share is built to expose one small, isolated service to the internet. If you find a way around that, please
tell us privately before telling anyone else.

## Reporting

Use GitHub's **Report a vulnerability** button on the Security tab of this repository. Include the version or
commit, what an attacker needs (link id, full link, LAN access…) and the steps to reproduce.

You will get an answer within 7 days. Fixes ship with a regression test in `test/security.test.ts` and are
credited in the release notes unless you prefer otherwise.

## Scope

In scope: the edge, the broker, the admin API, the wire format and the recipient page. Out of scope: attacks that
need root on the host, and the tunnel or CDN provider dropping or delaying traffic.
