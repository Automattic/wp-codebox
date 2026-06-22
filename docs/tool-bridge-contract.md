# Tool Bridge Contract

`wp-codebox/tool-bridge/v1` is the WP Codebox-owned envelope for exposing
allowlisted sandbox tools to a disposable runtime. Consumers pass or resolve this
contract instead of installing runtime-specific PHP filters or transport details.

```json
{
  "schema": "wp-codebox/tool-bridge/v1",
  "version": 1,
  "allowed_tools": ["workspace.read"],
  "sandbox_tool_policy": {
    "schema": "wp-codebox/sandbox-tool-policy/v1",
    "version": 1,
    "tools": []
  },
  "host_policy": {
    "schema": "wp-codebox/host-tool-policy/v1",
    "version": 1,
    "tools": []
  },
  "dispatcher": {
    "owner": "wp-codebox",
    "callback": "wp_codebox_browser_runtime_tool_callback",
    "location": "sandbox"
  },
  "authorization": {
    "mode": "allowlist",
    "notes": "Only sandbox-visible tools in sandbox_tool_policy are exposed to the runtime agent. Parent control-plane actions remain outside the sandbox bridge."
  },
  "redaction": {
    "notes": "Secret values are passed through environment allowlists only and must not be embedded in tool bridge payloads, logs, or dispatcher metadata."
  }
}
```

The bridge carries the same enforced `sandbox_tool_policy` snapshot used by the
runtime plus a Codebox-owned `host_policy` projection for host/runtime adapters.
WP Codebox exposes tools only when a policy entry is allowed, sandbox visible,
and runtime-local. Parent-only, hidden, or denied entries remain present for
diagnostics but are not exposed to the sandbox agent.

Integration points:

- Pass `tool_bridge` in `wp-codebox/task-input/v1` when the caller already has a
  resolved bridge.
- Use `WP_Codebox_Sandbox_Tool_Policy_Normalizer::tool_bridge_from_allowed_tools()`
  to build the default Codebox-owned bridge for semantic `allowed_tools`.
- Use `wp_codebox_resolved_tool_bridge` to decorate the default bridge with
  caller metadata while preserving the Codebox schema and sandbox policy.
- Use `wp_codebox_tool_bridge` only when the caller needs to supply the full
  bridge and no explicit `tool_bridge` or `sandbox_tool_policy` was provided.

The legacy sandbox policy filters remain supported as lower-level policy
customization points. New integrations should target the tool bridge contract so
dispatcher metadata, authorization notes, and redaction notes stay attached to
the tool surface handed to sandbox runtimes.
