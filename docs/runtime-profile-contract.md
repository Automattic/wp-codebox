# Runtime Profile Contract

`wp-codebox/runtime-profile/v1` is the Codebox-owned runtime request/result
contract for callers that need an agent-capable WordPress sandbox without binding
to backend plugin names, overlay paths, activation order, or readiness probes.

Callers request profiles by generic capabilities or component selectors. WP
Codebox resolves those selectors into backend details internally, then returns a
portable profile envelope with:

- `schema`: `wp-codebox/runtime-profile/v1`.
- `capabilities`: normalized capability strings provided by the resolved profile.
- `components`: runtime components selected for the sandbox.
- `plugins`, `mu_plugins`, `themes`, `overlays`: optional dependency descriptors
  for backend materialization.
- `runtime_overlays`, `runtime_state_mounts`, `runtime_config_mounts`: optional
  generic mount descriptors for backend adapters.
- `readiness`: `ready`, `missing`, `blocked`, `pending`, or `unknown` with checks
  and missing dependency evidence.
- `diagnostics`: structured, non-secret resolver evidence for operators and UI.
- `provenance`: Codebox ownership and resolver metadata.

The profile contract is the public lane. Consumers should not depend on Agents
API, Data Machine, Data Machine Code, provider plugin paths, overlay file paths,
activation order, or backend readiness internals. Those may appear in backend
execution plans or diagnostics, but the caller-facing request/result remains the
generic Codebox profile.

Example request fragment:

```json
{
  "runtime_profile": {
    "capabilities": ["agents.runtime", "provider.openai"],
    "components": ["workspace-overlay"]
  }
}
```

Example resolved profile fragment:

```json
{
  "schema": "wp-codebox/runtime-profile/v1",
  "capabilities": ["wordpress.playground", "browser.preview", "agents.runtime", "provider.openai"],
  "components": [{ "kind": "component", "slug": "workspace-overlay" }],
  "readiness": {
    "status": "ready",
    "checks": { "dependencies": true },
    "missing": []
  },
  "diagnostics": [{
    "code": "runtime_profile.resolved",
    "status": "ready",
    "severity": "info",
    "message": "Runtime profile resolved by WP Codebox."
  }],
  "provenance": { "owner": "wp-codebox" }
}
```
