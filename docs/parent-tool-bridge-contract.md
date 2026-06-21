# Parent Tool Bridge Contract

`wp-codebox/parent-tool-bridge/v1` is the Codebox-owned contract for sandbox
runtimes that need to request host-dispatched tools without receiving host
credentials or product-specific bridge code.

This contract is separate from `wp-codebox/tool-bridge/v1`. The existing tool
bridge exposes runtime-local, sandbox-visible tools. The parent tool bridge
describes calls that leave the sandbox through an allowlisted host dispatcher.

## Bridge Envelope

```json
{
  "schema": "wp-codebox/parent-tool-bridge/v1",
  "version": 1,
  "allowed_tools": ["workspace.read"],
  "dispatcher": {
    "owner": "wp-codebox",
    "mode": "host_endpoint",
    "endpoint": {
      "url_env": "WP_CODEBOX_PARENT_TOOL_ENDPOINT",
      "method": "POST",
      "token_env": "WP_CODEBOX_PARENT_TOOL_TOKEN"
    },
    "request_schema": "wp-codebox/parent-tool-request/v1",
    "result_schema": "wp-codebox/parent-tool-result/v1",
    "timeout_ms": 30000
  },
  "sandbox_env": {
    "mode": "metadata-only",
    "variables": {
      "bridge_ref": "WP_CODEBOX_PARENT_TOOL_BRIDGE_REF",
      "bridge_schema": "WP_CODEBOX_PARENT_TOOL_BRIDGE_SCHEMA",
      "dispatch_mode": "WP_CODEBOX_PARENT_TOOL_DISPATCH_MODE",
      "request_schema": "WP_CODEBOX_PARENT_TOOL_REQUEST_SCHEMA",
      "result_schema": "WP_CODEBOX_PARENT_TOOL_RESULT_SCHEMA"
    },
    "secret_env": [],
    "notes": "Sandbox env injection carries only contract ids, dispatch mode, and optional artifact/env references. It must not include parent credentials or tool result payloads."
  },
  "authorization": {
    "mode": "allowlist",
    "failure_status": "denied",
    "notes": "The parent dispatcher executes only tools listed in allowed_tools and returns denied for authorization failures without attempting fallback execution inside the sandbox."
  },
  "redaction": {
    "transcript_artifact_refs": [],
    "notes": "Dispatchers persist redacted request/result transcripts as artifacts and return refs. Secret values, bearer tokens, cookies, and host-local paths stay out of envelopes and transcripts."
  },
  "metadata": {}
}
```

For command dispatch, use `dispatcher.mode: "host_command"` and provide
`dispatcher.command.argv`. The command reads a
`wp-codebox/parent-tool-request/v1` JSON envelope from its declared transport and
returns a `wp-codebox/parent-tool-result/v1` JSON envelope. Codebox owns the
envelope; host adapters own the concrete endpoint URL, command argv, and secret
resolution.

## Request Envelope

```json
{
  "schema": "wp-codebox/parent-tool-request/v1",
  "version": 1,
  "request_id": "ptr_123",
  "tool": "workspace.read",
  "operation": "call",
  "input": { "path": "README.md" },
  "sandbox_session": {
    "sandbox_session_id": "sandbox_123",
    "caller_session_id": "job_456",
    "task_id": "task_789"
  },
  "authorization": {
    "allowed_tools": ["workspace.read"],
    "capability": "read",
    "principal": {}
  },
  "metadata": {}
}
```

`input` is opaque product payload. Codebox validates the envelope shape and
allowlist; product adapters validate tool-specific payloads.

## Result Envelope

```json
{
  "schema": "wp-codebox/parent-tool-result/v1",
  "version": 1,
  "request_id": "ptr_123",
  "tool": "workspace.read",
  "operation": "call",
  "status": "succeeded",
  "output": { "contents": "..." },
  "artifacts": {
    "transcripts": [
      {
        "kind": "tool-call-transcript",
        "path": "files/parent-tools/ptr_123.json"
      }
    ],
    "evidence": []
  },
  "diagnostics": {},
  "metadata": {}
}
```

Failure statuses are stable:

- `denied`: the tool, operation, principal, or capability is not authorized.
- `unavailable`: the parent dispatcher cannot be reached or is not configured.
- `timeout`: the dispatcher exceeded its declared timeout.
- `failed`: the dispatcher ran and returned a tool/runtime failure.

Failure results include `error.code`, `error.message`, and `error.retryable`.
The sandbox must not silently fall back to local execution for parent tools.

## Adapter Hooks

Minimal integration points:

- Pass `parent_tool_bridge` in `wp-codebox/task-input/v1` when the caller has a
  resolved bridge.
- Host request normalization preserves `parent_tool_bridge` from
  `parent_request` into the sandbox run input.
- CLI input accepts `--parent-tool-bridge='<json>'` as an object-valued field.

Host adapters can map their endpoint or command metadata into this Codebox
contract without adding product semantics to WP Codebox core. Upstream systems
provide generic tool/run inputs; Codebox performs any WP Codebox schema mapping at its boundary. When an adapter dispatches to an external tool registry, the adapter
maps Codebox canonical ids such as `workspace.read`, `workspace.search`,
`workspace.write`, and `workspace.edit` outward to that registry's ids. The
external registry does not need to recognize `wp-codebox/sandbox-tool-policy/v1`.
