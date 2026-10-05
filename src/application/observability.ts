export type SignalSeverity = "warning" | "critical";
export type OverallOperationalStatus = "healthy" | "warning" | "critical";

export type SloThresholds = {
  inbox_count_warning: number;
  inbox_count_critical: number;
  inbox_age_warning_seconds: number;
  inbox_age_critical_seconds: number;
  outbox_count_warning: number;
  outbox_count_critical: number;
  outbox_age_warning_seconds: number;
  outbox_age_critical_seconds: number;
  stale_lease_warning: number;
  stale_lease_critical: number;
  fifo_blocker_warning: number;
  fifo_blocker_critical: number;
  prompt_failure_warning: number;
  prompt_failure_critical: number;
  sheets_review_warning: number;
  sheets_review_critical: number;
  sheets_failed_warning: number;
  sheets_failed_critical: number;
  integration_retrying_warning: number;
  integration_retrying_critical: number;
  integration_stale_active_warning: number;
  integration_stale_active_critical: number;
  uncertain_delivery_warning: number;
  uncertain_delivery_critical: number;
  outbox_retrying_warning: number;
  outbox_retrying_critical: number;
  dead_letter_warning: number;
  dead_letter_critical: number;
};

export const DEFAULT_SLO_THRESHOLDS: SloThresholds = {
  inbox_count_warning: 10,
  inbox_count_critical: 50,
  inbox_age_warning_seconds: 300,
  inbox_age_critical_seconds: 900,
  outbox_count_warning: 10,
  outbox_count_critical: 50,
  outbox_age_warning_seconds: 300,
  outbox_age_critical_seconds: 900,
  stale_lease_warning: 1,
  stale_lease_critical: 5,
  fifo_blocker_warning: 1,
  fifo_blocker_critical: 5,
  prompt_failure_warning: 1,
  prompt_failure_critical: 5,
  sheets_review_warning: 1,
  sheets_review_critical: 5,
  sheets_failed_warning: 1,
  sheets_failed_critical: 5,
  integration_retrying_warning: 1,
  integration_retrying_critical: 5,
  integration_stale_active_warning: 1,
  integration_stale_active_critical: 5,
  uncertain_delivery_warning: 1,
  uncertain_delivery_critical: 1,
  outbox_retrying_warning: 1,
  outbox_retrying_critical: 5,
  dead_letter_warning: 1,
  dead_letter_critical: 5,
};

export type OperationalSnapshot = {
  inbox: { count: number; oldestAgeSeconds: number };
  outbox: { count: number; oldestAgeSeconds: number; uncertainCount: number };
  retryingDeliveries: number;
  integrationRetryingDeliveries: number;
  deadLetter: number;
  integrationStaleActive: number;
  staleLeases: number;
  fifoBlockers: number;
  promptFailures: number;
  sheetsReviewRequired: number;
  sheetsFailed: number;
};

export type OperationalSignal = {
  code: string;
  severity: SignalSeverity;
  value: number;
  context_json: string;
  operator_action: string;
};

export type OperationalSignalReport = {
  status: OverallOperationalStatus;
  generated_at: string;
  thresholds: SloThresholds;
  signals: OperationalSignal[];
};

function boundedContext(value: Record<string, unknown>): string {
  const result = JSON.stringify(value).slice(0, 512);
  return result.length === 512 ? `${result.slice(0, 509)}...` : result;
}

function severity(value: number, age: number, warning: number, critical: number, ageWarning: number, ageCritical: number): SignalSeverity | null {
  if (value >= critical || age >= ageCritical) return "critical";
  if (value >= warning || age >= ageWarning) return "warning";
  return null;
}

function countSeverity(value: number, warning: number, critical: number): SignalSeverity | null {
  if (value >= critical) return "critical";
  if (value >= warning) return "warning";
  return null;
}

export function buildOperationalSignals(
  snapshot: OperationalSnapshot,
  thresholds: SloThresholds = DEFAULT_SLO_THRESHOLDS,
): OperationalSignalReport {
  const signals: OperationalSignal[] = [];
  const add = (code: string, value: number, age: number, warning: number, critical: number, ageWarning: number, ageCritical: number, action: string) => {
    const level = severity(value, age, warning, critical, ageWarning, ageCritical);
    if (level) signals.push({ code, severity: level, value, context_json: boundedContext({ count: value, oldest_age_seconds: age }), operator_action: action });
  };
  const addCount = (code: string, value: number, warning: number, critical: number, action: string) => {
    const level = countSeverity(value, warning, critical);
    if (level) signals.push({ code, severity: level, value, context_json: boundedContext({ count: value }), operator_action: action });
  };
  add("inbox_backlog", snapshot.inbox.count, snapshot.inbox.oldestAgeSeconds, thresholds.inbox_count_warning, thresholds.inbox_count_critical, thresholds.inbox_age_warning_seconds, thresholds.inbox_age_critical_seconds, "Inspect the inbox worker and oldest unprocessed message.");
  add("outbox_backlog", snapshot.outbox.count, snapshot.outbox.oldestAgeSeconds, thresholds.outbox_count_warning, thresholds.outbox_count_critical, thresholds.outbox_age_warning_seconds, thresholds.outbox_age_critical_seconds, "Inspect the sender queue and provider acceptance state.");
  addCount("uncertain_delivery", snapshot.outbox.uncertainCount, thresholds.uncertain_delivery_warning, thresholds.uncertain_delivery_critical, "Resolve each uncertain send from provider evidence before retrying.");
  addCount("outbox_retrying_delivery", snapshot.retryingDeliveries, thresholds.outbox_retrying_warning, thresholds.outbox_retrying_critical, "Inspect normal WhatsApp retry cause and bounded retry budget.");
  addCount("integration_retrying_delivery", snapshot.integrationRetryingDeliveries, thresholds.integration_retrying_warning, thresholds.integration_retrying_critical, "Inspect integration retry cause and bounded retry budget.");
  addCount("dead_letter", snapshot.deadLetter, thresholds.dead_letter_warning, thresholds.dead_letter_critical, "Review terminal integration failures and replay only after diagnosis.");
  addCount("integration_stale_active", snapshot.integrationStaleActive, thresholds.integration_stale_active_warning, thresholds.integration_stale_active_critical, "Inspect the integration worker lease and recover only after confirming ownership.");
  addCount("stale_lease", snapshot.staleLeases, thresholds.stale_lease_warning, thresholds.stale_lease_critical, "Inspect worker heartbeat/lease ownership and recover the stale worker.");
  addCount("fifo_blocker", snapshot.fifoBlockers, thresholds.fifo_blocker_warning, thresholds.fifo_blocker_critical, "Inspect the predecessor message or blocked conversation key.");
  addCount("prompt_failure", snapshot.promptFailures, thresholds.prompt_failure_warning, thresholds.prompt_failure_critical, "Inspect bounded planner failure diagnostics and route to fallback/human review.");
  addCount("sheets_review_required", snapshot.sheetsReviewRequired, thresholds.sheets_review_warning, thresholds.sheets_review_critical, "Review the import batch reconciliation report before retrying apply.");
  addCount("sheets_import_failed", snapshot.sheetsFailed, thresholds.sheets_failed_warning, thresholds.sheets_failed_critical, "Inspect the failed import batch and its row-level evidence before retrying.");
  const status: OverallOperationalStatus = signals.some((s) => s.severity === "critical") ? "critical" : signals.length ? "warning" : "healthy";
  return { status, generated_at: new Date().toISOString(), thresholds, signals };
}
