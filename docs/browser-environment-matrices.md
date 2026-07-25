# Browser environment matrices

`wp-codebox/browser-environment-matrix/v1` expands hostile browser conditions
into deterministic, bounded cells. It composes existing probe, action, adaptive,
visual, accessibility, and multi-actor executors through one callback rather
than duplicating their execution logic.

```ts
const matrix = browserEnvironmentMatrix({
  id: "responsive-accessibility",
  seed: "ci-42",
  dimensions: [
    { id: "viewport", values: [
      { id: "desktop", environment: { viewport: { width: 1280, height: 720 } } },
      { id: "mobile", environment: { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true } },
    ] },
    { id: "preferences", values: [
      { id: "default", environment: { colorScheme: "light", reducedMotion: "no-preference" } },
      { id: "hostile", environment: { colorScheme: "dark", reducedMotion: "reduce", forcedColors: "active" } },
    ] },
  ],
  limits: {
    maxCells: 4,
    maxDurationMs: 120_000,
    maxCellDurationMs: 30_000,
    maxArtifactBytes: 50 * 1024 * 1024,
  },
})
```

## Expansion and bounds

Dimension and value ids are sorted before cartesian expansion, so declaration
or object insertion order cannot change cell order. Each cell derives its id and
seed from the matrix seed, selected value ids, and canonical requested
environment. Conflicting assignments from two dimensions are rejected.

Construction fails before execution when the cartesian product exceeds
`maxCells` or when `cells * maxCellDurationMs` exceeds `maxDurationMs`. Execution
is sequential by default. The runner additionally stops on wall-time,
interruption, or aggregate artifact-byte exhaustion while preserving every
completed cell report.

## Capabilities and fidelity

Values declare `requiredCapabilities` and `optionalCapabilities` using generic
runtime capability ids. A required unsupported capability fails the cell closed
without executing it. An optional unsupported capability executes when safe and
marks an otherwise passing cell `inconclusive`. Every cell records `exact`,
`emulated`, or `unsupported` fidelity and a reason.

The Playwright adapter included with WP Codebox 0.15 applies:

- viewport, named device, DPR, mobile, touch, and orientation context options;
- color scheme, reduced motion, forced colors, and contrast media features;
- locale, timezone, and online/offline state;
- fixed or realtime browser clock behavior;
- page-scale zoom with explicitly `emulated` fidelity;
- caller-declared CPU and network profiles through the browser debugging
  protocol with explicitly `emulated` fidelity;
- caller-declared generic capability state through an immutable page global.

Unknown device, CPU, or network profiles are unsupported rather than silently
falling back. OS-level zoom, browser chrome, server clocks, and transport-level
socket faults are not claimed. Transport degradation continues to use the
existing transport-fault contract.

## Evidence and replay

Callers provide a safe `runId`. Cell evidence belongs under:

```text
browser-matrices/<matrix-id>/<run-id>/cells/<index>-<cell-id>/
```

The Playwright adapter writes `matrix-report.json` beside the `cells` directory.
Each cell includes requested and effective environments, selected dimensions,
provider/browser/version provenance, capability fidelity, status, findings,
timing, artifact references, and an exact replay contract. Environment cell
identity participates in default finding fingerprints.

`browserEnvironmentMatrixFailed(report)` preserves fail-on-finding behavior:
incomplete runs always fail, while findings fail unless the declaration sets
`failOnFinding: false`. Completed evidence remains available in either case.

For multi-actor scenarios, resolve the shared cell once and create one context
per actor from that resolution. Explicitly different actor environments should
be represented as separate named dimensions and resolved before constructing
actor clients; never mix undeclared context settings inside one cell.
