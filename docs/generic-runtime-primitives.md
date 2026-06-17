# Generic Runtime Primitives

WP Codebox exposes generic contracts for parent control planes without naming a
product or job system.

## Contract Authority

- TypeScript implementations live in `packages/runtime-core/src/artifact-storage.ts`,
  `packages/runtime-core/src/browser-session-origin.ts`, and
  `packages/runtime-core/src/materialization-contracts.ts`, and
  `packages/runtime-core/src/evidence-artifact-envelope.ts`, and
  `packages/runtime-core/src/runtime-overlay-bundle.ts`, and
  `packages/runtime-core/src/command-agent-run.ts`.
- Coverage lives in `tests/generic-primitives.test.ts` and
  `tests/command-agent-run.test.ts`.
- `npm run check` runs that coverage through the smoke manifest `core` group.

## Artifact Storage

`wp-codebox/runtime-artifact-storage/v1` describes where runtime artifacts can be
written and how relative artifact paths map to public URLs when a public root is
available.

- `root` is an absolute writable filesystem root.
- `publicUrlRoot` is an optional normalized `http://` or `https://` URL root.
- `pathPrefix` is an optional safe relative prefix applied before artifact refs.

## Browser Session Origins

`wp-codebox/trusted-browser-session-origin/v1` normalizes trusted CORS origins for
browser-session bridges. `https://` origins are accepted. `http://` is accepted
only for loopback hosts.

## Materialization Results

`wp-codebox/materialization-phase-result/v1` records phase status and artifact
references produced while converting runtime output into durable artifacts. These
refs can be folded into run records as `materialization:<kind>` artifact refs.

## Evidence Artifact Envelopes

`wp-codebox/evidence-artifact-envelope/v1` is a caller-neutral envelope for
review artifacts produced by runtime workflows. It keeps product policy outside
WP Codebox while giving upstream consumers one stable shape for browser captures
and reviewer-safe artifact references.

- Artifact refs use bundle-relative paths, never host filesystem paths.
- Optional `publicUrl` values must be `http://` or `https://` and cannot point at
  loopback hosts such as `localhost` or `127.0.0.1`.
- Browser captures use `wp-codebox/browser-evidence-capture/v1` and group the
  screenshot, HTML, console, network, review, or other artifacts for one browser
  scenario without naming a downstream product.

```ts
import { evidenceArtifactEnvelope } from "@automattic/wp-codebox-core"

const envelope = evidenceArtifactEnvelope({
  id: "run-1",
  subject: { kind: "component", id: "example" },
  status: "passed",
  artifacts: [{ path: "files/review.md", kind: "review" }],
  browserCaptures: [{
    id: "homepage",
    status: "passed",
    finalUrl: "https://example.test/",
    artifacts: [{ path: "files/browser/home.png", kind: "browser-screenshot" }],
  }],
})
```

## Runtime Overlay Bundles

`wp-codebox/runtime-overlay-bundle/v1` is a generic runtime overlay metadata
primitive for recipe authors and backend implementations. It describes what an
overlay needs without encoding downstream product policy or executing the
overlay by itself.

- `files` declare sandbox files with local sources or inline contents.
- `configPreludes` declare ordered snippets or files a backend can prepend to
  runtime configuration.
- `localRoutes` declare loopback-only route aliases; routes must set
  `localOnly: true`.
- `patches` record patch provenance with source and optional digest metadata.
- `capabilities` is a manifest of provided, required, and optional capability
  strings.
- `unsupportedGaps` are explicit fail-closed blockers. `runtimeOverlayBundle()`
  throws when any are present so callers do not silently run with a partial
  overlay.

Recipe schema accepts these bundles through `runtime.overlays[]`:

```json
{
  "kind": "runtime-overlay-bundle",
  "bundle": {
    "schema": "wp-codebox/runtime-overlay-bundle/v1",
    "id": "example-runtime-overlay",
    "files": [{ "path": "/wordpress/wp-content/mu-plugins/example.php", "source": "overlays/example.php" }],
    "configPreludes": [{ "target": "wp-config.php", "contents": "define('EXAMPLE_RUNTIME', true);", "order": 10 }],
    "localRoutes": [{ "path": "/_runtime/example", "target": "http://127.0.0.1:9400/example", "localOnly": true }],
    "patches": [{ "id": "example.patch", "source": "patches/example.patch", "appliesTo": "runtime" }],
    "capabilities": { "provided": ["example/runtime-overlay"] }
  }
}
```

## Target Context Provisioning

`wp-codebox target provision --json` emits a `wp-codebox/target-context/v1`
envelope. The command does not start a runtime or persist state; it gives callers
a normalized target/session/storage context they can pass into recipes, browser
sessions, or external orchestrators.

Example:

```sh
wp-codebox target provision --json \
  --id example \
  --kind wordpress-site \
  --workspace-root /workspace \
  --artifact-public-url-root https://artifacts.example.test/run-1 \
  --trusted-origin https://preview.example.test
```

## Command Agent Runs

`command-agent-run` is a product-neutral runtime command wrapper. It executes one
declared runtime command and emits a `wp-codebox/command-agent-run/v1` envelope
with stdout, stderr, exit code, normalized status, optional parsed JSON, session
metadata, auth context keys, environment variable names, diagnostics, and artifact
refs.

The wrapper fails closed:

- `command` is required.
- The target command must already be allowed by runtime policy.
- `command-agent-run` cannot target itself.
- `auth-required=true` requires `auth-context-json`.
- Runtime metadata is required before an envelope can be created.

Environment reporting includes names only. Runtime and secret environment values
are not included in the envelope.

Example recipe step:

```json
{
  "command": "command-agent-run",
  "args": [
    "command=inspect-mounted-inputs",
    "args-json=[]",
    "parse-json=false",
    "session-id=example-session",
    "correlation-id=example-correlation"
  ]
}
```
