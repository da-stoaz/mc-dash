// ---------------------------------------------------------------------------
// The slice of the Minecraft protocol MC Dash speaks.
//
// The router already had to *read* a handshake to know which server a
// connection wanted. Hibernation needs to *answer* as well: a sleeping server
// has no process to forward to, so MC Dash itself has to tell the client what
// is going on — otherwise a woken server looks exactly like a broken one.
//
// Only the handshake, status and login-disconnect packets are implemented.
// Everything past that point is a real server's job.
// ---------------------------------------------------------------------------

const MAX_VARINT_BYTES = 5;

export type VarIntResult = { value: number; size: number };

export function readVarInt(buffer: Buffer, offset: number): VarIntResult | null {
  let result = 0;
  let shift = 0;
  let size = 0;

  while (size < MAX_VARINT_BYTES) {
    if (offset + size >= buffer.length) return null;
    const byte = buffer[offset + size];
    result |= (byte & 0x7f) << shift;
    size += 1;
    if ((byte & 0x80) !== 0x80) {
      return { value: result, size };
    }
    shift += 7;
  }

  return null;
}

export function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0; // protocol VarInts here are never negative
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

export function writeString(value: string): Buffer {
  const payload = Buffer.from(value, 'utf8');
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

/** Frame a packet: length-prefixed (packet id + payload). */
export function packet(packetId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const body = Buffer.concat([writeVarInt(packetId), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

export type Handshake = {
  protocolVersion: number;
  hostname: string;
  port: number;
  /** 1 = the client is listing servers, 2 = it is trying to join. */
  nextState: number;
  /** Total bytes the handshake packet occupied, so callers can read on. */
  size: number;
};

/**
 * Parse a handshake from the head of `buffer`.
 *
 * Returns null when the packet is incomplete — the caller should buffer more
 * and try again. Throws when the bytes are something other than a modern
 * handshake, which the caller has to distinguish from "not yet".
 */
export function parseHandshake(buffer: Buffer): Handshake | null {
  if (buffer.length === 0) return null;
  // 0xFE is the pre-1.7 server list ping, a completely different format.
  if (buffer[0] === 0xfe) throw new Error('Legacy ping packet');

  const packetLength = readVarInt(buffer, 0);
  if (!packetLength) return null;
  const packetEnd = packetLength.size + packetLength.value;
  if (buffer.length < packetEnd) return null;

  let offset = packetLength.size;
  const packetId = readVarInt(buffer, offset);
  if (!packetId) return null;
  if (packetId.value !== 0x00) throw new Error('Not a handshake packet');
  offset += packetId.size;

  const protocolVersion = readVarInt(buffer, offset);
  if (!protocolVersion) return null;
  offset += protocolVersion.size;

  const hostLength = readVarInt(buffer, offset);
  if (!hostLength) return null;
  offset += hostLength.size;
  if (offset + hostLength.value > buffer.length) return null;
  const hostname = buffer.slice(offset, offset + hostLength.value).toString('utf8');
  offset += hostLength.value;

  // Port is a plain unsigned short, not a VarInt.
  if (offset + 2 > buffer.length) return null;
  const port = buffer.readUInt16BE(offset);
  offset += 2;

  const nextState = readVarInt(buffer, offset);
  if (!nextState) return null;
  offset += nextState.size;

  return { protocolVersion: protocolVersion.value, hostname, port, nextState: nextState.value, size: packetEnd };
}

/**
 * Strip the extras clients append to the hostname: Forge's "\0FML\0" marker,
 * an explicit port, a trailing dot, casing.
 */
export function normalizeHostname(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const base = value.split('\0')[0];
  const withoutPort = base.split(':')[0];
  const trimmed = withoutPort.trim().replace(/\.$/, '').toLowerCase();
  return trimmed.length ? trimmed : undefined;
}

/**
 * A status response for a server that isn't running.
 *
 * The client's own protocol number is echoed back deliberately. Send a fixed
 * one and every sleeping server shows up in the list as "outdated client" or
 * "outdated server" with a red X, which reads as broken rather than asleep —
 * the exact confusion hibernation must avoid.
 */
export function sleepingStatusResponse(opts: {
  protocolVersion: number;
  versionName: string;
  description: string;
}): Buffer {
  const json = JSON.stringify({
    version: { name: opts.versionName, protocol: opts.protocolVersion },
    players: { max: 0, online: 0, sample: [] },
    description: { text: opts.description },
  });
  return packet(0x00, writeString(json));
}

/** Disconnect during login (state 2), where Disconnect is packet 0x00. */
export function loginDisconnect(message: string): Buffer {
  return packet(0x00, writeString(JSON.stringify({ text: message })));
}
