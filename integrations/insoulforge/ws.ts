// A tiny RFC 6455 client. Node 24's built-in WebSocket cannot set an Authorization header on the handshake, and
// InSoulForge deliberately accepts its Activity token only in that header. This handles the subset the protocol uses:
// text frames, ping/pong, close and fragmentation, with masked client frames.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";

export type Message = string | Uint8Array;
export type Socket = {
  send(text: string): void;
  close(): void;
  onopen?: () => void;
  onmessage?: (data: string) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
};

const MAX_FRAME = 1024 * 1024;

export function open(url: string, headers: Record<string, string> = {}): Promise<Socket> {
  const target = new URL(url);
  if (target.protocol !== "ws:" && target.protocol !== "wss:") return Promise.reject(new Error("只支持 ws/wss"));
  const secure = target.protocol === "wss:";
  const key = randomBytes(16).toString("base64");
  const request = (secure ? https : http).request({
    hostname: target.hostname,
    port: target.port || (secure ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: "GET",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
      ...headers,
    },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    request.once("response", (response) => {
      if (settled) return;
      settled = true;
      response.resume();
      reject(new Error(`WebSocket 握手失败：${response.statusCode}`));
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.once("upgrade", (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      const accept = response.headers["sec-websocket-accept"];
      const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (accept !== expected) {
        settled = true;
        socket.destroy();
        reject(new Error("WebSocket 握手校验失败"));
        return;
      }
      settled = true;
      resolve(attach(socket, head));
    });
    request.end();
  });
}

function attach(socket: import("node:net").Socket, head: Buffer): Socket {
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let closed = false;
  // The server can send a frame in the same packet as the 101 response. `open()` resolves before the caller assigns
  // `onmessage`, so hold completed messages until the callbacks are in place instead of dropping them.
  const early: string[] = [];
  let listener: ((data: string) => void) | undefined;
  const wrapper: Socket = {
    send(text) {
      if (closed || socket.destroyed) throw new Error("WebSocket 已关闭");
      writeFrame(socket, 0x1, Buffer.from(text, "utf8"));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        writeFrame(socket, 0x8, Buffer.alloc(0));
        socket.end();
      } catch {}
      // InSoulForge may close the handshake while a caller is waiting for `ready`. That caller listens for `onclose`, so
      // an explicit local close must notify it too; otherwise the top-level await never settles and Node exits.
      queueMicrotask(() => wrapper.onclose?.());
    },
    get onmessage() {
      return listener;
    },
    // A frame can arrive between the handshake resolving and the caller assigning `onmessage`. Flush those frames here,
    // once there is somewhere to put them, rather than dropping the first `ready`.
    set onmessage(next: ((data: string) => void) | undefined) {
      listener = next;
      if (next) for (const text of early.splice(0)) next(text);
    },
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    wrapper.onclose?.();
  };
  socket.setNoDelay(true);
  const receive = (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    for (;;) {
      const frame = readFrame(buffer);
      if (!frame) return;
      buffer = buffer.subarray(frame.bytes);
      if (frame.opcode === 0x8) {
        wrapper.close();
        return;
      }
      if (frame.opcode === 0x9) {
        try {
          writeFrame(socket, 0xa, frame.payload);
        } catch {}
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        fragments = [frame.payload];
        fragmentOpcode = frame.opcode;
      } else if (frame.opcode === 0x0 && fragmentOpcode) {
        fragments.push(frame.payload);
      } else {
        continue;
      }
      if (fragments.reduce((size, part) => size + part.length, 0) > MAX_FRAME) {
        wrapper.close();
        return;
      }
      if (frame.fin) {
        const payload = Buffer.concat(fragments);
        fragments = [];
        fragmentOpcode = 0;
        const text = payload.toString("utf8");
        if (listener) listener(text);
        else early.push(text);
      }
    }
  };
  // The server may put the first frame in `head`, alongside the 101 response. That data would never produce a `data`
  // event, so feed it through the parser before waiting for more.
  if (head?.length) receive(head);
  socket.on("data", receive);
  socket.on("error", (error) => {
    if (!closed) wrapper.onerror?.(error);
    finish();
  });
  socket.on("close", finish);
  queueMicrotask(() => wrapper.onopen?.());
  return wrapper;
}

function readFrame(buffer: Buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0]!;
  const second = buffer[1]!;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) throw new Error("WebSocket 帧过大");
    length = Number(big);
    offset = 10;
  }
  if (length > MAX_FRAME) throw new Error("WebSocket 帧过大");
  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  let payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]!;
  return { fin, opcode, payload, bytes: offset + length };
}

function writeFrame(socket: import("node:net").Socket, opcode: number, payload: Buffer) {
  const masked = randomBytes(4);
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index++) maskedPayload[index] ^= masked[index % 4]!;
  socket.write(Buffer.concat([header, masked, maskedPayload]));
}
