# T20 legacy Sheets import and reconciliation

T20 is an offline/disposable-database importer for the canonical 28-column legacy export. It does not call Google, WAHA, production databases, or external services. `scripts/sheets-import.mjs` is the single parser/stager/apply/rollback entry point; `sheets-stage.mjs` and `sheets-reconcile.mjs` are compatibility/reporting wrappers over the same parser.

## Operator flow

```text
node scripts/sheets-import.mjs --file <export.csv> --source-label <stable-label> --mode dry-run
T20_DISPOSABLE=true TEST_DATABASE_URL=<disposable-url> DB_SCHEMA=haim_core_test \
  node scripts/sheets-import.mjs --file <export.csv> --source-label <stable-label> --mode apply [--allow-review]
T20_DISPOSABLE=true TEST_DATABASE_URL=<disposable-url> DB_SCHEMA=haim_core_test \
  node scripts/sheets-import.mjs --rollback <batch-id>
```

Apply and rollback are refused unless `T20_DISPOSABLE=true` is present. Dry-run never mutates business tables. A repeated `(source_label, source_hash)` is the same batch, and row lineage makes apply idempotent. Failed/rolled-back batches are closed to normal apply; recovery requires explicit `--revalidate`, which re-stages the source before applying.

## Lifecycle

`staged` → `validated` → `apply_ready` → `applied`; invalid/blocking data enters `review_required`, an apply failure enters `failed`, and a verified rollback enters `rolled_back`. Review rows (loss-risk or media references) require `--allow-review`; blocking parser exceptions can never be bypassed.

## Canonical transforms and policy

- Headers must match the exact mapping in `config/legacy-sheets-v9-mapping.json`.
- CSV parsing is quote-aware, supports escaped quotes and CRLF/LF, and emits deterministic source and row SHA-256 hashes.
- Israeli phone numbers normalize to digits with the `972` prefix removed for storage; invalid phones are blocking.
- Boolean values accept the explicit Hebrew/English true/false forms only; quantities and floors are strict integers.
- Dates/timestamps are strict ISO values: date-only values are accepted as UTC midnight, while datetimes require an explicit `Z` or numeric offset. Unknown statuses are blocking. Known statuses are exactly `collecting`, `available`, `awaiting_approval`, `waiting_capacity`, `coordinated`, `human`, `cancel_pending`, `cancelled`, `closed`, and `rejected`.
- `הערות`, `סטטוס בוט`, `נדרש טיפול אנושי`, and media references are preserved and surfaced as field-level review. The human-review flag is not copied into `requests.human_reason`; it remains an independent review value. Unsupported preferred-time text is preserved for review and is not silently converted. Media is stored as a reference only; T20 does not fetch or reinterpret the file.
- `created_at` and `updated_at` are persisted on the imported request. Approval columns map only `approved_at`/`approved_by`; schedule approval remains false/null until the application receives explicit schedule consent.
- Coordinated rows require a pre-existing `transport_runs` row for the exact Tuesday. The importer never invents capacity or creates transport runs, so rollback cannot remove or alter a pre-existing run.
- Duplicate request numbers are classified as identical source duplicates or conflicting content. Existing request-number collisions block apply.
- Locations must already exist in the disposable `service_locations` allowlist. No new location is invented by the importer.

## Reconciliation and rollback

Reports include source/row hashes, exceptions, review fields, state, applied/skipped rows, and lineage counts for requests, parties, items, media references, and locations. `--reconcile <batch-id>` computes expected lineage from staged rows and compares it with actual lineage; mismatches exit non-zero. Every imported request has a `legacy_sheet_imported` event carrying source row/hash and preserved source payload. Rollback deletes only entities marked `created_by_import=true`, never a pre-existing contact or transport run, and is idempotent.
