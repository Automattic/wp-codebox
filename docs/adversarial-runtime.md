# Adversarial runtime

WP Codebox exposes backend-neutral adversarial campaign and transport-fault
contracts from `@automattic/wp-codebox-core/public`. The contracts compose with
the existing fuzz suite, runtime episode, checkpoint, browser, service, artifact,
and replay surfaces; they do not replace those surfaces.

## Architecture

- `adversarial-campaign.ts` owns deterministic corpus scheduling, generic value
  and action-sequence mutation, novelty retention, bounded concurrent execution,
  minimization, stable finding fingerprints, replay schedules, and differential
  result classification.
- `transport-faults.ts` owns request matching, deterministic stateful outcome
  sequences, capability negotiation, redacted evidence, and deduplication. It
  does not assume a browser, HTTP library, application, or transport.
- `adversarial-browser.ts` owns DOM-derived journey planning, hostile generic
  input generation, journey minimization, and user-facing oracle contracts.
- `browser-accessibility.ts` owns provider-neutral accessibility configuration,
  normalized findings, capability status, and stable privacy-safe fingerprints.
  The Playground adapter collects bounded DOM, focus, keyboard, geometry, and
  redacted ARIA-tree evidence through the existing adaptive browser runner.
- `adversarial-artifacts.ts` writes bounded manifested finding and replay bundles,
  removes declared secrets and machine-specific paths, and seals corpus/finding
  identity with a deterministic content digest.
- `runtime-playground` maps supported fault outcomes and browser clock controls
  onto Playwright. Socket behavior that Playwright cannot faithfully produce is
  reported as unsupported.
- `runtime-services.ts` provisions loopback-only, ephemeral MySQL/MariaDB, Redis,
  SMTP sink, and HTTP fixture services. Every service has idempotent teardown and
  typed disruption controls.

Generic layers contain no component, plugin, vendor integration, or product
policy. WordPress grammars and attack packs remain extension responsibilities.

## Campaign contract

```ts
const campaign = adversarialCampaign({
  id: "component-campaign",
  seed: "ci-seed-1",
  corpus: [{
    id: "create-update-read",
    actions: [
      { type: "create", input: { title: "seed" } },
      { type: "update", input: { title: "candidate" } },
      { type: "read" },
    ],
  }],
  budgets: {
    maxCases: 1000,
    workers: 4,
    maxCaseTimeMs: 30000,
    maxWallTimeMs: 300000,
  },
  oracles: [{
    schema: "wp-codebox/adversarial-oracle/v1",
    id: "state-integrity",
    severity: "high",
  }],
})

const result = await runAdversarialCampaign(campaign, {
  execute: async (plan, signal) => adapter.execute(plan, signal),
  evaluate: async (plan, observation, oracles) =>
    adapter.evaluate(plan, observation, oracles),
})
```

Workers execute a deterministic round concurrently. Results are committed to the
corpus in case-index order after every round, so completion timing cannot change
the retained corpus or later mutations. Replay metadata records the seed,
worker, iteration, matrix cell, minimized actions/input, fault schedule, exact
provenance, normalized schedule, and a one-command replay instruction.

## Mutation and novelty

Core mutation supports generic scalar, structured, binary, and stateful sequence
inputs. Mutation targets are selected from stable JSON paths using a seeded
SHA-256 schedule. Extensions can represent multipart, serialized, markup, or
domain-specific inputs as structured actions and register richer mutators at the
adapter boundary without adding those grammars to runtime-core.

Adapters return bounded novelty signals such as coverage edges, route ids, state
digests, hook ids, or query fingerprints. New signals retain a case in the
interesting corpus. Minimization removes action chunks and shrinks input values,
replaying each candidate through the same adapter and oracle set.

## Fault model

```json
{
  "schema": "wp-codebox/transport-fault-model/v1",
  "seed": "fault-seed-1",
  "rules": [{
    "id": "verification-outage",
    "match": {
      "host": "service.example",
      "method": "POST",
      "path": "/verify"
    },
    "sequence": [
      { "status": 500 },
      { "delayMs": 30000, "timeoutMs": 1000 },
      { "status": 200, "body": "malformed", "truncateAfterBytes": 4 }
    ],
    "repeat": "last"
  }]
}
```

Each adapter publishes `wp-codebox/transport-fault-capabilities/v1`. Campaigns
must negotiate before execution and fail closed when a required semantic is
unsupported.

### Playwright fidelity

| Semantic | Fidelity |
| --- | --- |
| Response status/header/body substitution | Exact |
| Delay, deterministic jitter, host remap | Exact |
| Malformed/truncated payload, bandwidth, timeout, refusal/reset | Emulated and labeled |
| Chunk framing, half-close, disconnect-after-N-bytes | Unsupported |

Playwright owns HTTP framing and sockets, so payload truncation must not be
reported as a transport disconnect. A lower-level proxy provider is required for
those exact semantics.

## Services

Recipe `inputs.services` accepts:

- `mysql`: MySQL 8.4 or MariaDB 11.4, preserving existing output and readiness
  behavior.
- `redis`: ephemeral Redis with persistence disabled.
- `smtp`: SMTP message sink plus its loopback inspection port.
- `http`: deterministic loopback response fixture.

The provisioned service set exposes `control(serviceId, action, options)`.
Container lifecycle actions (`stop`, `start`, `pause`, `resume`, `restart`,
`disconnect`, and `reconnect`) have exact Docker fidelity. Provider-specific
`flush` and read-only controls are exact where implemented. Network latency is
explicitly unsupported by this provider and should use the transport-fault
adapter instead.

All containers bind ephemeral loopback ports, use no persistent volumes, and are
removed in reverse order after success, failure, cancellation, or timeout.

## Clock control

Playwright browser time supports exact freeze, advance, skew, and resume through
its clock API. The same capability response explicitly marks server process,
scheduler, and database clocks unsupported. A WordPress runtime extension is
required to control those surfaces without faking server behavior in browser
JavaScript.

## Browser oracles

The generic browser planner derives actions from visible control descriptors and
generates empty, oversized, hostile punctuation, bidi, and Unicode inputs. Submit
controls are repeated to expose duplicate side effects. Generic oracles cover:

- page errors, console errors, and unhandled rejections;
- controls that accept input without an observable action;
- loading indicators that exceed a declared threshold;
- clipping, viewport overflow, and invisible focus;
- adapter-provided accessibility violations;
- duplicate observable effects.

Journey minimization uses deterministic subset replay to retain the shortest
sequence that preserves the oracle failure.

### Accessibility and keyboard exploration

Add `accessibility` to `adaptive-exploration-json` to scan the initial state,
each novel state, and the final state. The contract accepts `ruleTags`,
`includeScopes`, `excludeScopes`, `impactThreshold`, `cadence`, required or
optional `rules`, `focus`, and `accessibilityTree` capabilities, plus explicit
scan, violation, focus-history, tree-size, and keyboard-action budgets.
Scope selectors are resolved independently in every inspectable frame. A target
is included when it matches or descends from an `includeScopes` selector (or
when no include selector is declared), and it is always removed when it matches
or descends from an `excludeScopes` selector. Excludes therefore override
overlapping or nested includes. The same rule applies to static, keyboard,
focus, and dialog findings. Focus may cross a scope boundary and remain in the
bounded transition history or a finding's expected/actual context, but an
out-of-scope element is never itself emitted as the finding target.

Invalid scope selectors and include selectors that match no inspectable frame
make the scan inconclusive instead of producing a silent pass. Frames that
cannot be inspected produce an explicit diagnostic; findings from inspectable
same-origin frames retain their stable frame identity.

```json
{
  "schema": "wp-codebox/browser-adaptive-exploration/v1",
  "seed": "accessible-settings",
  "startUrl": "/settings/",
  "accessibility": {
    "ruleTags": ["accessible-name", "keyboard-reachable", "focus-visible", "dialog-focus", "aria-state"],
    "impactThreshold": "serious",
    "cadence": ["initial", "novel-state", "final"],
    "capabilities": { "rules": "required", "focus": "required", "accessibilityTree": "optional" },
    "budgets": { "maxScans": 24, "maxViolationsPerScan": 25, "maxFocusTransitions": 100, "maxTreeChars": 20000, "maxKeyboardActions": 8 }
  }
}
```

The collector classifies unnamed controls, keyboard-unreachable custom
controls, unexpected tab stops, hidden/inert/clipped/offscreen focus, focus loss,
dialog entry/containment/restoration failures, and observable ARIA state drift.
Every finding records its oracle, rule, impact, structural target, state and
transition context, screenshot, correlated bounded DOM snapshot, and stable
fingerprint. ARIA-tree names are redacted and target evidence excludes text.
Unavailable tree capabilities produce an explicit `unsupported` scan. Required
capabilities make the exploration incomplete; optional capabilities allow the
campaign to continue without turning the unsupported check into a pass.
Existing caller-supplied `accessibilityViolations` remain supported.

## Evidence and safety

`writeAdversarialEvidenceBundle()` writes a manifest, campaign result, one
finding and replay document per stable fingerprint, and a secret-scan report.
The writer enforces an artifact byte ceiling, redacts sensitive fields and
caller-declared values, removes machine-specific paths, and records SHA-256 file
digests plus a stable bundle content digest.

Campaign budgets independently bound cases, actions, input bytes, per-case and
wall time, worker count, and artifact bytes. Adapters remain responsible for the
existing Codebox CPU, memory, disk, process, network-deny, mount, and disposable
sandbox boundaries.

## Compatibility

Existing recipes and `fuzzRun` cases are unchanged. Existing MySQL defaults,
outputs, readiness, and teardown behavior remain compatible. The new service
kinds and public TypeScript contracts are additive.

## Current boundaries

The following capabilities are intentionally not claimed by this change:

- exact socket framing faults require a lower-level proxy provider;
- server-side WordPress HTTP fault interception requires a WordPress extension
  adapter using the generic fault contract;
- PHP/WordPress, cron, and database clock control require a WordPress extension;
- WordPress-specific mutation grammars, security policies, and instrumentation
  remain extension-owned;
- live vulnerable plugin/theme discovery campaigns require disposable runtime
  fixtures and are not replaced by the neutral contract tests.

These are capability gaps, not silent skips. Consumers can inspect negotiation
results before running a campaign.
