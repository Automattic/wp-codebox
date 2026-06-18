# Browser Parent-Tool Bridge Next PR

This PR intentionally stops at executable blueprint refs and runtime profile application.

The next parent-tool bridge seam should define one bounded contract for browser sandboxes to request parent-owned tools without receiving parent credentials. The contract should cover:

- A product-safe request envelope, for example `wp-codebox/browser-parent-tool-request/v1`, with `tool`, `operation`, opaque `input`, `sandbox_session_id`, `caller_session_id`, and authorization context.
- A parent-side ability or adapter hook that executes the requested tool and returns a redacted response envelope.
- A browser-side bridge descriptor that can be passed through task input without embedding secrets.
- Tests proving redaction, authorization failure, and opaque product payload preservation.

Keep executable blueprint hydration on `wp-codebox/hydrate-browser-blueprint-ref`; do not couple parent-tool execution to blueprint storage.
