import { constants } from "node:fs";
import { mkdir, open, rename, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { AppError, RetryableError } from "../domain/types.js";
export interface StoredMedia {
  key: string;
  checksum: string;
  mime: string;
  size: number;
}
export interface MediaStorage {
  init(): Promise<void>;
  put(bytes: Buffer, kind: "image" | "voice"): Promise<StoredMedia>;
  get(key: string): Promise<Buffer>;
  check(): Promise<void>;
}

async function syncDurably(file: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await file.sync();
  } catch (error) {
    // Windows filesystems used for local development may reject fsync. The
    // deployed EasyPanel image runs on Linux, where fsync remains mandatory.
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EINVAL")) return;
    throw error;
  }
}

export function detectMedia(
  b: Buffer,
): { ext: string; mime: string; kind: "image" | "voice" } | null {
  if (b.length < 12) return null;
  if (b.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    return { ext: "jpg", mime: "image/jpeg", kind: "image" };
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { ext: "png", mime: "image/png", kind: "image" };
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return { ext: "webp", mime: "image/webp", kind: "image" };
  if (b.subarray(0, 4).toString() === "OggS")
    return { ext: "ogg", mime: "audio/ogg", kind: "voice" };
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WAVE"
  )
    return { ext: "wav", mime: "audio/wav", kind: "voice" };
  if (b.subarray(4, 8).toString() === "ftyp")
    return { ext: "m4a", mime: "audio/mp4", kind: "voice" };
  if (
    b.subarray(0, 3).toString() === "ID3" ||
    (b[0] === 255 && (b[1]! & 224) === 224)
  )
    return { ext: "mp3", mime: "audio/mpeg", kind: "voice" };
  return null;
}
export class LocalMediaStorage implements MediaStorage {
  private root = "";
  constructor(private readonly config: Config) {}
  async init(): Promise<void> {
    const path = join(this.config.MEDIA_ROOT, this.config.DB_SCHEMA);
    await mkdir(path, { recursive: true, mode: 0o700 });
    this.root = await realpath(path);
    await this.check();
  }
  async check(): Promise<void> {
    if (!this.root) throw new Error("storage_not_initialized");
    const p = join(this.root, `.check-${randomUUID()}`);
    const f = await open(p, "wx", 0o600);
    await f.close();
    await rm(p);
  }
  async put(bytes: Buffer, kind: "image" | "voice"): Promise<StoredMedia> {
    if (bytes.length > this.config.MEDIA_MAX_BYTES)
      throw new AppError("media_too_large");
    const m = detectMedia(bytes);
    if (!m || m.kind !== kind) throw new AppError("unsupported_media");
    const checksum = createHash("sha256").update(bytes).digest("hex"),
      key = `${checksum}.${m.ext}`,
      tmp = join(this.root, `.tmp-${randomUUID()}`);
    const f = await open(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await f.writeFile(bytes);
      await syncDurably(f);
    } finally {
      await f.close();
    }
    await rename(tmp, join(this.root, key));
    const dir = await open(this.root, constants.O_RDONLY);
    try {
      await syncDurably(dir);
    } finally {
      await dir.close();
    }
    return { key, checksum, mime: m.mime, size: bytes.length };
  }
  async get(key: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}\.(jpg|png|webp|ogg|mp3|m4a|wav)$/.test(key))
      throw new AppError("invalid_media_key");
    const f = await open(
      join(this.root, key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const s = await f.stat();
      if (!s.isFile() || s.size > this.config.MEDIA_MAX_BYTES)
        throw new AppError("invalid_media_file");
      const bytes = await f.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== key.slice(0, 64))
        throw new AppError("media_checksum_mismatch");
      return bytes;
    } finally {
      await f.close();
    }
  }
}
export function allowedMediaUrl(value: string, c: Config): URL {
  const u = new URL(value),
    base = new URL(c.WAHA_BASE_URL),
    extra = c.WAHA_MEDIA_ORIGINS.split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  if (
    u.username ||
    u.password ||
    !["http:", "https:"].includes(u.protocol) ||
    u.hash
  )
    throw new AppError("unsafe_media_url");
  if (u.origin !== base.origin && !extra.includes(u.origin))
    throw new AppError("media_origin_not_allowed");
  if (u.origin === base.origin && !u.pathname.startsWith("/api/files/"))
    throw new AppError("unsafe_waha_media_path");
  return u;
}
export async function downloadMedia(
  url: string,
  c: Config,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const u = allowedMediaUrl(url, c),
    controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.MEDIA_TIMEOUT_MS);
  try {
    const r = await fetcher(u, {
      headers:
        u.origin === new URL(c.WAHA_BASE_URL).origin
          ? { "X-Api-Key": c.WAHA_API_KEY }
          : {},
      redirect: "error",
      signal: controller.signal,
    });
    if (!r.ok || !r.body) throw new RetryableError("media_download_failed");
    const length = Number(r.headers.get("content-length") ?? 0);
    if (length > c.MEDIA_MAX_BYTES) throw new AppError("media_too_large");
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > c.MEDIA_MAX_BYTES) {
        controller.abort();
        throw new AppError("media_too_large");
      }
      parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts);
  } finally {
    clearTimeout(timer);
  }
}
