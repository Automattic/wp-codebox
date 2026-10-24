# Host Tool Registry

`HostToolRegistry` is a WP Codebox transport adapter, not a generic tool
contract. The caller owns the canonical tool declarations, concrete tool
sources, execution result semantics, pending external-tool states, runtime
metadata, and product policy.
WP Codebox only exposes caller-provided per-run tool declarations to sandbox
agents, routes allowed calls across the browser/host boundary, and records
transport diagnostics.

Host products can register a caller-provided canonical tool declaration plus a
host-side handler without adding product-specific logic to WP Codebox core. The
runtime still gates execution through `RuntimePolicy.commands`, so callers must
explicitly allow each registered canonical tool name before a sandbox can invoke
it.

```ts
import { createHostToolRegistry } from "@automattic/wp-codebox-core/public"

const hostTools = createHostToolRegistry([
  {
    declaration: {
      name: "client/echo",
      description: "Echo a structured payload from the host bridge.",
      parameters: {
        type: "object",
        required: ["message"],
        properties: { message: { type: "string" } },
        additionalProperties: false,
      },
      executor: "client",
      scope: "run",
      runtime: { completion_signal: "progress" },
    },
    name: "client/echo",
    description: "Echo a structured payload from the host bridge.",
    outputSchema: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
      additionalProperties: false,
    },
    policy: { capability: "client/echo", risk: "read" },
    handler: (input) => input,
  },
])

// Pass `hostTools` through the Codebox runtime task/session options for the run
// that is allowed to execute `client/echo`.
```

Host tool output is a Codebox transport diagnostic envelope with schema
`wp-codebox/host-tool-result/v1`. Successful calls return `status: "ok"`, an
`output` value validated against the transport output schema, and `toolResult`
using the caller's canonical tool result shape: `success`, `tool_name`,
`result`, `metadata`, and optional `runtime`. Invalid input, invalid output,
malformed JSON, and handler failures return `status: "error"` with a stable
transport error code while `toolResult` maps the same failure to a canonical
tool error. The `diagnostics` object is the Codebox-owned portion of the
envelope and preserves the transport, policy command, validation schemas, and
resolved policy metadata.

Product-specific tools such as evidence commands should live in product
extensions that provide canonical tool declarations and handlers through this
transport surface. Codebox should not encode product policy semantics,
product tool names, or cross-product tool mediation rules in this layer.

Trusted worker hosts that need repo-local commands can register a Codebox host
tool adapter instead of exposing arbitrary shell.
Each adapter is still a named host tool such as `host.pnpm-test`,
`host.cargo-test`, or `host.project-check`; the runtime denies it unless that
exact name appears in `policy.commands`. The adapter runs one configured
executable with `child_process.spawn()` and `shell: false`, appends only
structured string-array arguments from the input, enforces allowed cwd roots,
uses an explicit timeout, captures bounded stdout/stderr, and passes only
configured environment variables plus explicitly allowlisted input env keys.

The adapter configuration names one executable, fixed base arguments, allowed
working-directory roots, timeout and output limits, and explicitly inherited
environment variables.
