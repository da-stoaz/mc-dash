# Deferred: Minecraft router protection

Recorded 2026-10-22. Follow-up work, not implemented or a prerequisite for
finishing the current player-count/settings changes.

## Findings from the repository

- The public Minecraft router runs in the same Node process as the dashboard
  API (`backend/src/index.ts`). Router resource exhaustion can therefore affect
  the panel even when its web traffic comes through Cloudflare.
- The router has an 8 KB handshake limit and a five-second handshake timeout,
  but no per-IP connection-rate limits or overall connection cap.
- Malformed or timed-out handshakes can be forwarded to the configured default
  server instead of being rejected.
- Docker publishes Minecraft ports without a loopback-only binding. They may
  permit direct access around the router, depending on the host firewall.
- Sleeping-server listeners also bind without an explicit local address.
- Wake-on-connect happens before player authentication and can be abused to
  trigger server starts.
- Per-connection logging could amplify a flood into excessive log volume.

These are code/configuration findings. The Ubuntu host's actual exposed ports,
firewall rules, Cloudflare origin restrictions, and provider-side DDoS protection
have **not** been audited. Do not assume either zero upstream protection or a
protected origin from this note.

## Proposed work, in order

1. Restrict Minecraft ports and sleeping listeners to local/private access when
   routing is enabled. Preserve an explicit direct-connect mode when it is not.
   Check IPv4, IPv6, Docker publishing, existing-container migration, and access
   to the dashboard origin outside Cloudflare.
2. Reject malformed/incomplete handshakes without forwarding them. Add bounded
   per-IP and global connection-rate/concurrency controls, upstream connection
   deadlines, complete socket cleanup, wake throttling, and bounded logging.
   Account for legitimate players sharing an IP and trusted upstream proxies.
3. Separate the public router from the dashboard API process, with independently
   bounded resources. Avoid making the controller unavailable under router load.
4. Assess provider-side mitigation or a protected Minecraft/TCP proxy. Local
   controls cannot prevent an upstream link from becoming saturated. Restrict
   direct origin access so a proxy cannot be bypassed.

## Validation before calling it protected

Use controlled local/disposable test environments: verify connection and memory
bounds under bursts and slow/incomplete handshakes; normal joins, pings, and
reconnects; no leaked sockets; wake throttling; private backend ports; and panel
responsiveness during router overload. Test deployment networking on Linux.
Application hardening alone must not be described as volumetric DDoS protection.

## Related decisions

The current router routes by hostname; it does not authenticate players or
enforce whitelist/blacklist entries. Immediate bans are sent to Minecraft over
RCON. A maximum-player setting does not protect against connection floods.

Cloudflare's normal website proxy does not cover Minecraft on port 25565.
Spectrum is a separate TCP/UDP protection product; deployment, compatibility,
plan availability, and origin restrictions need evaluation before choosing it.

References:

- [Cloudflare supported proxy ports](https://developers.cloudflare.com/fundamentals/reference/network-ports/)
- [Spectrum DDoS protection](https://developers.cloudflare.com/spectrum/about/ddos-for-spectrum/)
- [Protecting proxy backend servers](https://docs.papermc.io/velocity/security/)
