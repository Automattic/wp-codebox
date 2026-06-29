# Query Observation Contract

`wp-codebox/query-observation/v1` is the public artifact contract for SQL/query
evidence captured during WordPress runtime work. It is additive and caller
neutral: callers correlate it with fuzz suites, benchmark runs, or standalone
runtime commands through the artifact metadata rather than product-specific
assumptions.

## Shape

Each artifact contains:

- `schema`: `wp-codebox/query-observation/v1`.
- `suiteId`, `caseId`, and `actionId` when emitted from fuzz execution.
- `command` and `target` for the runtime action or command that produced the
  database activity.
- `queryCount` and `totalTimeMs` when the runtime recorder exposes them.
- `fingerprints`: normalized query fingerprints with count, operation type,
  table references, timing, caller/source attribution, and row counts or
  affected rows when available.
- `duplicateGroups`: fingerprint groups with `count > 1` for scale waste
  discovery.
- `tables`: extracted table references from recorder metadata or SQL
  fingerprints.
- `artifactRefs`: supporting execution artifacts.

## Fuzz Artifacts

Runtime-backed fuzz suites materialize per-case query observations into the
durable fuzz artifact bundle when artifact storage is enabled:

```text
fuzz/<suite-id>/files/query-observations/<case-id>-<n>.json
```

The result metadata also includes `metadata.artifacts.queryObservations` with a
compact index of the emitted observations and artifact refs. Without artifact
storage, the same metadata index is emitted inline with `persisted: false` so
callers can still discover query-observation availability from the public result
envelope.

## Capture Sources

WP Codebox currently normalizes query evidence from:

- command and runtime-action result payloads containing `database` metrics,
  fingerprints, and repeated-query groups;
- REST DB query profiler artifacts embedded in workload/benchmark results;
- the shared WordPress query recorder used by performance and admin fuzz paths.

The query recorder normalizes literal values out of SQL fingerprints, extracts
operation type and table references, records duplicate query groups, includes
caller attribution when `$wpdb->queries` provides it, and preserves timing when
available.
