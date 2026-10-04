import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOperationalSignals,
  DEFAULT_SLO_THRESHOLDS,
  type OperationalSnapshot,
} from "../src/application/observability.js";
import {
  redactSecrets,
  validateAdminSecret,
  rotationPlan,
} from "../src/application/security.js";
import { readConfig } from "../src/config.js";
import {
  createBackupManifest,
  validateBackupManifest,
  type BackupComponent,
} from "../src/application/backup.js";

test("T21 signals classify backlog, retry, terminal, stale and FIFO states", () => {
  const snapshot: OperationalSnapshot = {
    inbox: { count: 11, oldestAgeSeconds: 301 },
    outbox: { count: 12, oldestAgeSeconds: 301, uncertainCount: 1 },
    retryingDeliveries: 2,
    deadLetter: 1,
    staleLeases: 1,
    fifoBlockers: 1,
    promptFailures: 1,
    sheetsReviewRequired: 1,
  };
  const result = buildOperationalSignals(snapshot, DEFAULT_SLO_THRESHOLDS);
  assert.equal(result.status, "critical");
  assert.deepEqual(
    result.signals.map((signal) => signal.code),
    [
      "inbox_backlog",
      "outbox_backlog",
      "uncertain_delivery",
      "retrying_delivery",
      "dead_letter",
      "stale_lease",
      "fifo_blocker",
      "prompt_failure",
      "sheets_review_required",
    ],
  );
  for (const signal of result.signals) {
    assert.ok(signal.context_json.length <= 512);
  }
});

test("T22 redaction removes secrets recursively and admin secrets are strong", () => {
  const redacted = redactSecrets({
    token: "super-secret-token",
    authorization: "Bearer abc",
    nested: { password: "pw", message: "safe" },
  });
  assert.deepEqual(redacted, {
    token: "[REDACTED]",
    authorization: "[REDACTED]",
    nested: { password: "[REDACTED]", message: "safe" },
  });
  assert.equal(validateAdminSecret("short"), false);
  const current = "A7!current-secret-rotation-2026-01";
  const next = "B8@next-secret-rotation-2026-02!!";
  assert.equal(validateAdminSecret(current), true);
  assert.deepEqual(rotationPlan(current, next), {
    accepted: true,
    overlap: true,
  });
  assert.equal(rotationPlan(current, current).accepted, false);
  assert.throws(() => readConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://test/test",
    DB_SCHEMA: "haim_core",
    BOT_MODE: "live",
    AI_ENABLED: "false",
    WAHA_WEBHOOK_HMAC_KEY: "h".repeat(32),
    HAIM_ADMIN_TOKEN: "short",
    WAHA_API_KEY: "waha",
    LIVE_DEPENDENCIES_VERIFIED: "true",
    MEDIA_VOLUME_CONFIRMED: "true",
  }), /admin_token_too_weak/);
});

test("T22 backup manifest requires every component and verifies checksums", async () => {
  const components: BackupComponent[] = [
    { name: "postgres", path: "db.dump", sha256: "a".repeat(64), bytes: 10 },
    { name: "media", path: "media.tar", sha256: "b".repeat(64), bytes: 20 },
    { name: "configuration", path: "config.json", sha256: "c".repeat(64), bytes: 30 },
  ];
  const manifest = await createBackupManifest(components, {
    consistency: "single-disposable-snapshot",
    rpo_minutes: 60,
    rto_minutes: 30,
  });
  assert.equal(validateBackupManifest(manifest).ok, true);
  assert.equal(validateBackupManifest({ ...manifest, components: components.slice(0, 2) }).ok, false);
});
