# Location source audit

## Scope

This audit records what is available locally for the location rules in
`HAIM_YAHAD_PROMPT_V48-HUMAN-CALLBACK-ALERT.txt` and prevents the runtime from
presenting a partial list as if it were the official municipal street dataset.

## Sources checked

- The V48 prompt contains the behavioral rules: בית שאן accepts a street,
  neighborhood, area, landmark or known place; nearby settlements accept a
  general in-settlement description; the service boundary includes ירדנה,
  בית אלפא, טירת צבי, כפר רופין and מחולה; עפולה, צמח and תל אביב are outside.
- The local Apps Script source was checked for the same location terms. It
  contains the legacy data model/mapping, but no complete authoritative
  בית-שאן street snapshot.
- The repository contains the explicitly approved aliases `שיכון א` and
  `רחוב העלייה` in `db/migrations/012_location_datasets.sql`, a two-row unit
  fixture, and a staged 244-row official-source artifact at
  `tests/fixtures/beit-shean-streets-official.csv` with a sidecar checksum.
- A current public candidate source was identified: the Population and
  Immigration Authority's updating Israel street list, resource
  `9ad3862c-8391-4b2f-84a4-2d4c68625f4b` in data.gov.il. It is a nationwide
  source, so the בית שאן subset, checksum, aliases and settlement code still
  require a reviewed import before activation.

## Result

The location pipeline is structurally ready (versioned dataset, aliases,
normalization, dry-run validation and active-dataset lookup), and the complete
official בית-שאן street list is now staged for review. It is not activated yet:
activation still requires a reviewed snapshot and an explicit operator action.
Until activation, unknown street names are deliberately handled by the prompt's
fallback to a nearby street, landmark or WhatsApp location; no street names
are invented.

The existing two-row fixture is test data only and must not be represented as
the complete municipal list.
