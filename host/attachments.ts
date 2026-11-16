// Uploaded files live beside the hub's data, addressed by a random id. This module owns their bytes and ownership; the
// kernel only records the reference an event carries, so the fact log stays small and the kernel never touches a file.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./home.ts";
import { privateDirectory } from "./files.ts";
import { InputError, NotFound } from "../kernel/errors.ts";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, type EventAttachment } from "../protocol/validate.ts";

const ROOT = join(HOME, "attachments");
const ID = /^att_[0-9a-f]{16}$/;
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
privateDirectory(ROOT);

type Stored = EventAttachment & { source: string };

function metaPath(id: string) {
  return join(ROOT, `${id}.json`);
}
function bytesPath(id: string) {
  return join(ROOT, `${id}.bin`);
}

/** The declared type has to match the bytes, so a renamed HTML file cannot arrive as an image. */
function actualType(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function safeName(name: string, mediaType: string): string {
  if (typeof name !== "string" || !name || name.length > 200 || /[/\\\x00-\x1f\x7f]/.test(name)) {
    throw new InputError("附件 name 要是安全的图片文件名");
  }
  if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) throw new InputError("附件 name 要是图片文件名");
  return name;
}

/** Keep the bytes first and the metadata last: a reader never sees a reference whose bytes are missing. */
export function save(source: string, name: unknown, mediaType: unknown, bytes: Buffer): EventAttachment {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new InputError("附件不能为空");
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new InputError(`附件不能超过 ${MAX_ATTACHMENT_BYTES} 字节`);
  if (typeof mediaType !== "string" || !(ATTACHMENT_TYPES as readonly string[]).includes(mediaType)) {
    throw new InputError("附件 mediaType 只能是 PNG、JPEG、WebP 或 GIF");
  }
  if (actualType(bytes) !== mediaType) throw new InputError("附件内容和 mediaType 不一致");
  if (typeof name !== "string") throw new InputError("附件 name 要是文字");
  if (name !== name.normalize("NFC")) throw new InputError("附件 name 要是规范的 Unicode 文件名");
  const safe = safeName(name, mediaType);
  const id = `att_${randomBytes(8).toString("hex")}`;
  const temporary = join(ROOT, `${id}.tmp`);
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, bytesPath(id));
  const stored: Stored = { id, name: safe, mediaType, size: bytes.length, source };
  writeFileSync(`${metaPath(id)}.tmp`, JSON.stringify(stored), { mode: 0o600 });
  renameSync(`${metaPath(id)}.tmp`, metaPath(id));
  return { id, name: safe, mediaType, size: bytes.length };
}

function readMeta(id: string, missing: "event" | "download" = "event"): Stored {
  if (!ID.test(id))
    throw missing === "event" ? new InputError("附件 id 不是中台签发的编号") : new NotFound("没有这个附件");
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf8")) as Stored;
  } catch {
    throw missing === "event" ? new InputError("附件不存在或已过期") : new NotFound("没有这个附件");
  }
}

/** What a source's event may reference: only its own uploads, still present, with the metadata it received. */
export function ownedBy(source: string, references: EventAttachment[] | undefined): void {
  for (const reference of references ?? []) {
    const stored = readMeta(reference.id);
    if (stored.source !== source) throw new InputError("附件不存在或不属于这个来源");
    if (!existsSync(bytesPath(reference.id))) throw new InputError("附件已过期");
    if (stored.name !== reference.name || stored.mediaType !== reference.mediaType || stored.size !== reference.size) {
      throw new InputError("附件的名字、类型或大小与上传时不一致");
    }
  }
}

export function read(source: string, id: string): { bytes: Buffer; mediaType: string; name: string } {
  const stored = readMeta(id, "download");
  if (stored.source !== source) throw new NotFound("没有这个附件");
  let bytes: Buffer;
  try {
    bytes = readFileSync(bytesPath(id));
  } catch {
    throw new NotFound("没有这个附件");
  }
  if (bytes.length !== stored.size || createHash("sha256").update(bytes).digest("hex").length !== 64) {
    throw new NotFound("附件已损坏");
  }
  return { bytes, mediaType: stored.mediaType, name: stored.name };
}

/** Bytes for a run whose token and event reference the kernel has already checked. */
export function forRun(_run: number, _token: string, id: string): { bytes: Buffer; mediaType: string; name: string } {
  const meta = readMeta(id, "download");
  let bytes: Buffer;
  try {
    bytes = readFileSync(bytesPath(id));
  } catch {
    throw new NotFound("没有这个附件");
  }
  if (bytes.length !== meta.size) throw new NotFound("附件已损坏");
  return { bytes, mediaType: meta.mediaType, name: meta.name };
}

export function remove(id: string): void {
  if (!ID.test(id)) return;
  rmSync(metaPath(id), { force: true });
  rmSync(bytesPath(id), { force: true });
}
