# Destructive Fuzz DB Write Sets

Destructive WordPress fuzz runs emit DB write-set ledgers for waste and hotspot discovery. The ledger is observational evidence only; it is not a rollback, revert, or safety contract.

## Contract

Schema: `wp-codebox/wordpress-db-write-set/v1`

Artifact kind: `wordpress-db-write-set`

Each artifact records:

- `suiteId`, `caseId`, `action`, and `target` correlation.
- `entries[]` with `table`, `operation` (`insert`, `update`, `delete`, `replace`), `rowsAffected` when the command exposes it, object/resource correlation when available, and before/after row counts where feasible.
- `repeatedWrites[]` for repeated writes to the same observed table/operation/fingerprint key.
- `totals` for write count, affected rows, table count, and repeated write keys.
- `artifactRefs` that point back to command/runtime evidence used to build the ledger.

## Runtime Coverage

The runtime emits write-set ledgers for destructive paths where write evidence is available:

- `rest_request` destructive mutations enable query capture and derive write entries from observed SQL write statements.
- `crud_operation` mutations wrap WordPress CRUD calls in the generic query recorder and attach resource/object correlation.
- `db_operation` bounded writes emit direct table, mutation, rows affected, and before/after row counts.
- Admin/action paths that request query capture surface the same query recorder `writeSet` fields for downstream artifact builders.

Durable fuzz artifact bundles persist per-case ledgers under `files/db-write-sets/<case>.json` and include references in the case artifact refs. Inline runs expose the same artifact under `case.metadata.dbWriteSet` with `persisted: false`.
