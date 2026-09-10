import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../domain/types.js";
import { canonicalPhone } from "../domain/policies.js";
const packet = z
  .object({
    event: z.string(),
    session: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  .loose();
export interface ParsedMessage {
  external_id: string;
  chat_id: string;
  kind: "text" | "image" | "voice" | "contact" | "location";
  text: string;
  media_url: string | null;
  contacts: { phone: string; name: string | null }[];
  location: { latitude: number; longitude: number } | null;
}
export function verifyHmac(
  raw: Buffer,
  key: string,
  signature: unknown,
): boolean {
  if (typeof signature !== "string" || !/^[a-fA-F0-9]{128}$/.test(signature))
    return false;
  return timingSafeEqual(
    createHmac("sha512", key).update(raw).digest(),
    Buffer.from(signature, "hex"),
  );
}
const string = (x: unknown) => (typeof x === "string" ? x : "");
const record = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
export function parseWebhook(
  body: unknown,
  session: string,
): ParsedMessage | null {
  const parsed = packet.safeParse(body);
  if (!parsed.success) throw new AppError("malformed_webhook");
  const p = parsed.data.payload;
  if (
    parsed.data.session !== session ||
    !["message", "message.any"].includes(parsed.data.event) ||
    p.fromMe === true
  )
    return null;
  const chat = string(p.from);
  if (
    chat.endsWith("@g.us") ||
    chat === "status@broadcast" ||
    chat.endsWith("@newsletter") ||
    chat.endsWith("@broadcast")
  )
    return null;
  if (!/^\d+@(lid|c\.us|s\.whatsapp\.net)$/.test(chat))
    throw new AppError("unsupported_chat");
  const id = string(p.id);
  if (!id || id.length > 300) throw new AppError("missing_message_id");
  const media = record(p.media),
    data = record(p._data),
    location = record(p.location);
  const text = string(p.body);
  if (text.length > 16000) throw new AppError("message_too_large", 413);
  const type = string(p.type) || string(data.type);
  const mime = string(media.mimetype);
  const isImage = type === "image" || mime.startsWith("image/");
  const isVoice =
    ["ptt", "audio", "voice"].includes(type) || mime.startsWith("audio/");
  const contacts: { phone: string; name: string | null }[] = [];
  const cards = Array.isArray(p.vCards)
    ? p.vCards
    : typeof p.vcard === "string"
      ? [p.vcard]
      : text.includes("BEGIN:VCARD")
        ? [text]
        : [];
  for (const value of cards.slice(0, 10)) {
    const card =
      typeof value === "string" ? value : string(record(value).vcard);
    const phone = card.match(/^TEL[^:]*:([^\r\n]+)/im)?.[1];
    const name = card.match(/^FN:([^\r\n]+)/im)?.[1] ?? null;
    if (phone) {
      try {
        contacts.push({
          phone: canonicalPhone(phone),
          name: name?.slice(0, 160) ?? null,
        });
      } catch {
        /* Ignore invalid cards, never infer a phone from a LID. */
      }
    }
  }
  let loc: ParsedMessage["location"] = null;
  if (location.latitude !== undefined || type === "location") {
    const result = z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .safeParse(location);
    if (result.success) loc = result.data;
  }
  return {
    external_id: id,
    chat_id: chat,
    kind: isImage
      ? "image"
      : isVoice
        ? "voice"
        : contacts.length
          ? "contact"
          : loc
            ? "location"
            : "text",
    text: contacts.length ? "[כרטיס איש קשר]" : text,
    media_url: string(media.url) || null,
    contacts,
    location: loc,
  };
}
