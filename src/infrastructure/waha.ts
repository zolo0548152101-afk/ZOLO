import { z } from "zod";
import type { Config } from "../config.js";
import { canonicalPhone } from "../domain/policies.js";
import { AppError, RetryableError } from "../domain/types.js";
export class DeliveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly certainty: "rejected" | "unknown",
  ) {
    super(code);
  }
}
export interface Delivery {
  phone: string;
  chat_id: string;
  text: string;
  media?: { bytes: Buffer; mime: string; filename: string };
}
export interface Channel {
  resolve(chat: string): Promise<string>;
  send(d: Delivery): Promise<string>;
}
export class WahaChannel implements Channel {
  constructor(
    private readonly c: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async resolve(chat: string): Promise<string> {
    if (!chat.endsWith("@lid")) return canonicalPhone(chat);
    const lid = chat.slice(0, -4);
    if (!/^\d+$/.test(lid)) throw new AppError("invalid_lid");
    const r = await this.fetcher(
      `${this.c.WAHA_BASE_URL}/api/${this.c.WAHA_SESSION}/lids/${encodeURIComponent(lid)}`,
      {
        headers: { "X-Api-Key": this.c.WAHA_API_KEY },
        signal: AbortSignal.timeout(Math.min(5000, this.c.WAHA_TIMEOUT_MS)),
        redirect: "error",
      },
    );
    if (!r.ok) throw new RetryableError("lid_resolution_failed");
    const data = z
      .object({ pn: z.string() })
      .loose()
      .parse(await r.json());
    return canonicalPhone(data.pn);
  }
  async send(d: Delivery): Promise<string> {
    const fallback = `972${d.phone}@c.us`,
      routes = [d.chat_id, ...(d.chat_id !== fallback ? [fallback] : [])];
    for (const [i, chatId] of routes.entries()) {
      let r: Response;
      try {
        r = await this.fetcher(
          `${this.c.WAHA_BASE_URL}/api/${d.media ? "sendImage" : "sendText"}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "X-Api-Key": this.c.WAHA_API_KEY,
            },
            redirect: "error",
            signal: AbortSignal.timeout(this.c.WAHA_TIMEOUT_MS),
            body: JSON.stringify({
              session: this.c.WAHA_SESSION,
              chatId,
              ...(d.media
                ? {
                    caption: d.text,
                    file: {
                      mimetype: d.media.mime,
                      filename: d.media.filename,
                      data: d.media.bytes.toString("base64"),
                    },
                  }
                : { text: d.text }),
            }),
          },
        );
      } catch {
        throw new DeliveryError("waha_transport_unknown", "unknown");
      }
      if (r.ok) {
        try {
          const b = z
            .object({
              id: z.union([
                z.string(),
                z.object({ _serialized: z.string() }).loose(),
              ]),
            })
            .loose()
            .parse(await r.json());
          return typeof b.id === "string" ? b.id : b.id._serialized;
        } catch {
          throw new DeliveryError("waha_success_without_id", "unknown");
        }
      }
      // Only an explicit pre-delivery invalid-chat rejection permits route fallback.
      if (
        (r.status === 400 || r.status === 404 || r.status === 422) &&
        i === 0 &&
        routes.length > 1
      ) {
        const body = (await r.text()).slice(0, 2000);
        if (
          /(?:chat.*(?:not found|invalid)|(?:not found|invalid).*chat)/i.test(
            body,
          )
        )
          continue;
      }
      if (r.status >= 500)
        throw new DeliveryError("waha_server_unknown", "unknown");
      throw new DeliveryError(`waha_http_${r.status}`, "rejected");
    }
    throw new DeliveryError("waha_rejected", "rejected");
  }
}
export async function transcribe(
  bytes: Buffer,
  c: Config,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!c.IVRIT_API_TOKEN) throw new AppError("voice_not_configured");
  const r = await fetcher(c.IVRIT_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${c.IVRIT_API_TOKEN}`,
      "content-type": "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(c.IVRIT_TIMEOUT_MS),
    body: JSON.stringify({
      audio_blob: bytes.toString("base64"),
      method: "ivrit",
    }),
  });
  if (!r.ok) throw new RetryableError("transcription_failed");
  return z
    .object({ transcription: z.string().trim().min(1).max(16000) })
    .loose()
    .parse(await r.json()).transcription;
}
