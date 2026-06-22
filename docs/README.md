# WP Codebox Docs

Start here when authoring or maintaining WP Codebox integrations. The current
contracts are generated from code where possible; planning docs are historical
unless this index says otherwise.

## Current Contracts

- [Architecture](./architecture.md) explains the product boundary, package map,
  and ownership rules.
- [Recipe contract](./recipe-contract.md) is the authoring guide for
  `wp-codebox/workspace-recipe/v1` recipes, including supported input names and
  assertion syntax.
- [Sandbox session contract](./sandbox-session-contract.md) defines the parent
  orchestration boundary for sandbox sessions.
- [Tool bridge contract](./tool-bridge-contract.md) defines the Codebox-owned
  allowlisted sandbox tool envelope and dispatcher metadata.
- [Parent tool bridge contract](./parent-tool-bridge-contract.md) defines the
  Codebox-owned host-dispatched tool envelope, request/result schemas, sandbox
  env injection metadata, transcript artifact refs, and failure behavior.
- [Runner workspace backend contract](./runner-workspace-backend-contract.md)
  defines the generic backend filter schema behind public runner workspace
  abilities.
- [External apply adapter contract](./external-apply-adapter-contract.md)
  documents reviewed artifact apply-back.
- [Agent fanout contract](./agent-fanout-contract.md) documents generic
  multi-sandbox fanout inputs and outputs.
- [Agent runtime contract](./agent-runtime-contract.md)
  documents the stable orchestrator-facing agent-task CLI, schema boundary,
  artifacts, runner workspace publication, lifecycle metadata, provider
  overlays, and default sandbox bootstrap expectations.
- [Public API contract](./public-api-contract.md) defines stable package
  entrypoints, lifecycle contract areas, inspectable surfaces, Codebox's wrapper
  role around upstream runtime systems, and the limited role of `./internals`.
- [Generic runtime primitives](./generic-runtime-primitives.md) documents the
  caller-neutral artifact storage, trusted browser origin, materialization, and
  target-context envelopes shared by runtime integrations.
- [Runtime profile contract](./runtime-profile-contract.md) documents
  `wp-codebox/runtime-profile/v1`, the Codebox-owned profile request/result lane
  for capabilities, components, readiness, diagnostics, and provenance.
- [Portable WP Codebox](./portable-wp-codebox.md) documents portable runtime
  packaging and invocation.
- [Benchmark contract](./benchmark-contract.md) documents benchmark evidence
  shape without making benchmark scoring a core runtime concern.

## Example Consumer Integration Notes

- [Example consumer boundary contracts](./example-consumer-boundary-contracts.md)
  documents runtime profile, preview lease, and browser session handoff seams for
  host adapters. Named products in that note are examples only; the runtime
  contracts remain caller-neutral.

## Audits And Historical Plans

- [Browser runtime dependency audit](./browser-runtime-dependency-audit.md) is a
  current dependency classification reference.
- [Transfer readiness checklist](./transfer-readiness-checklist.md) and
  [transfer namespace plan](./transfer-namespace-plan.md) are historical transfer
  planning records. Keep them for provenance, but do not treat them as onboarding
  docs or current recipe contract authority.
- [Reprint parent-site snapshots](./reprint-parent-site-snapshots.md) is a
  planning note for a bounded parent-site snapshot surface.

## Contract Authority

- Recipe schema: `npm run wp-codebox -- schema recipe --json`.
- Command catalog: `npm run wp-codebox -- commands --json`.
- Runtime TypeScript contracts:
  `packages/runtime-core/src/runtime-contracts.ts`.
- Generic primitive TypeScript contracts:
  `packages/runtime-core/src/artifact-storage.ts`,
  `packages/runtime-core/src/browser-session-origin.ts`,
  `packages/runtime-core/src/materialization-contracts.ts`, and
  `packages/runtime-core/src/evidence-artifact-envelope.ts`.
- Runtime profile TypeScript contracts:
  `packages/runtime-core/src/runtime-boundary-contracts.ts` and
  `packages/runtime-core/src/runtime-profile-compiler.ts`.
- JSON Schema factory: `packages/runtime-core/src/recipe-schema.ts`.
- Default check coverage: `npm run check` includes
  `npm run test:generic-primitives` through the smoke manifest `core` group.
