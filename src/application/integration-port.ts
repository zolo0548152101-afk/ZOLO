/** External integrations consume committed audit events, never mutate aggregates
 * through SQL or make WhatsApp send calls. A future adapter submits the same
 * authorized application commands as other channels. */
export interface IntegrationEvent {
  id: string;
  type: string;
  requestId: string | null;
  occurredAt: string;
  data: unknown;
}
export interface IntegrationAdapter {
  readonly name: string;
  deliver(
    event: IntegrationEvent,
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<void>;
}
// No external integration is enabled by the release. Adding an adapter requires
// an explicit registry entry and an outbox consumer; config is not executable code.
export const integrationAdapters: ReadonlyMap<string, IntegrationAdapter> =
  new Map();
