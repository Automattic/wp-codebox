# Generic Runtime Primitives

WP Codebox exposes generic contracts for parent control planes without naming a
product or job system.

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
