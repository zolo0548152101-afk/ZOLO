import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { AppError } from "../domain/types.js";

export type AdminCapability = "read-only" | "normal" | "destructive";
const rank: Record<AdminCapability, number> = { "read-only": 0, normal: 1, destructive: 2 };

export function adminCapability(req: FastifyRequest): AdminCapability {
  const value = req.headers["x-admin-capability"];
  if (value === undefined) return "normal";
  if (value === "read-only" || value === "normal" || value === "destructive") return value;
  throw new AppError("admin_capability_invalid", 400, "הרשאת האדמין אינה תקינה.");
}

export function requireAdminCapability(
  req: FastifyRequest,
  required: Exclude<AdminCapability, "read-only">,
): AdminCapability {
  const capability = adminCapability(req);
  if (rank[capability] < rank[required])
    throw new AppError("admin_capability_forbidden", 403, "ההרשאה אינה מאפשרת את הפעולה.");
  return capability;
}

export function assertAdminSameOrigin(req: FastifyRequest, c: Config): void {
  let supplied: string | undefined = req.headers.origin;
  if (!supplied && req.headers.referer) {
    try { supplied = new URL(req.headers.referer).origin; }
    catch { throw new AppError("csrf_origin_rejected", 403, "מקור הבקשה אינו מורשה."); }
  }
  if (!supplied) return;
  const host = req.headers.host ?? `localhost:${c.PORT}`;
  const allowed = new Set([`http://${host}`, `https://${host}`, `http://localhost:${c.PORT}`, `http://127.0.0.1:${c.PORT}`]);
  if (!allowed.has(supplied)) throw new AppError("csrf_origin_rejected", 403, "מקור הבקשה אינו מורשה.");
}

export class AdminRateLimiter {
  private readonly buckets = new Map<string, { started: number; count: number }>();
  constructor(private readonly max = 20, private readonly windowMs = 60_000) {}
  check(req: FastifyRequest, token: string): void {
    const route = req.routeOptions.url ?? req.url.split("?")[0];
    const key = `${token}:${req.ip}:${route}`;
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || now - current.started >= this.windowMs) {
      this.buckets.set(key, { started: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.max) throw new AppError("admin_rate_limited", 429, "קצב הפעולות חרג מהמותר.");
  }
}

export function adminAuditFields(req: FastifyRequest): { actor: string; capability: AdminCapability } {
  return { actor: "admin-http", capability: adminCapability(req) };
}

export function assertDestructiveAllowed(req: FastifyRequest, c: Config): AdminCapability {
  const capability = requireAdminCapability(req, "destructive");
  if (c.NODE_ENV === "production" || c.BOT_MODE === "live")
    throw new AppError("destructive_admin_forbidden", 403, "פעולה הרסנית חסומה בסביבת production/live.");
  return capability;
}
