# Sandbox Session Contract

WP Codebox keeps sandbox execution generic and host-storage agnostic. It does not
create host-site database tables or own a queue. Parent control planes that need
durable sessions should create their own job/session record, then call WP Codebox
with a caller-owned `sandbox_session_id`.

## Boundary

```text
Parent control plane
  owns users, queues, jobs, retries, cancellation, retention, and UI history
    -> calls wp-codebox/run-agent-task with sandbox_session_id
      -> WP Codebox shells out to the CLI and captures artifacts
    <- returns wp-codebox/sandbox-session/v1 for correlation

Disposable Playground sandbox
  may mount agent runtimes, coding tools, and provider plugins
  owns in-sandbox agent behavior only
```

The host WP Codebox plugin receives parent job context through this session contract.
External orchestrators consume the same abilities and artifact contracts.

## Browser Playground Permission Model

`wp-codebox/create-browser-playground-session` returns an explicit browser
session boundary:

```json
{
  "execution": "browser-playground",
  "execution_scope": "disposable-playground",
  "permission_model": "runtime-principal",
  "session": {
    "execution_scope": "disposable-playground",
    "permission_model": "runtime-principal"
  }
}
```

The `runtime-principal` permission model means the generated browser runner
authorizes Agents API calls with a scoped runtime principal inside the disposable
Playground site. The principal binds the call to the WP Codebox client,
workspace, runtime type, and browser session instead of inheriting host-site user
state. This is safe only because the browser runner executes in PHP-WASM inside
the caller-owned Playground filesystem and cannot grant permissions on the host
WordPress site.

The generated PHP runner validates the expected Playground environment before it
registers runtime-principal authorization. If the runner is copied into a normal
host WordPress install, it fails with `wp_codebox_browser_runner_not_playground`
instead of executing the requested sandbox invocation.

## Browser Contained Site Handle

Browser session, materializer, and task contracts include an additive durable
handle for caller-owned preview recovery:

```json
{
  "contained_site": {
    "schema": "wp-codebox/browser-contained-site/v1",
    "site_id": "prepared-a1b2c3d4e5f6a7b8",
    "preview_id": "preview-1234abcd5678ef90",
    "session_id": "browser-session-123",
    "caller_id": "studio-native",
    "status": "ready",
    "persistence": "browser-contained",
    "source_digest": {
      "algorithm": "sha256",
      "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "recovery": {
      "ability": "wp-codebox/get-browser-contained-site-status",
      "input": {
        "cache_key": "prepared-a1b2c3d4e5f6a7b8",
        "input_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "source_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    }
  }
}
```

The handle is intentionally a primitive, not a parent-product lifecycle table.
`site_id` is stable for the caller plus normalized runtime/source inputs, and
`preview_id` is stable for the contained site plus browser session. The
`source_digest` is the prepared-runtime `input_hash` when available, or a stable
hash of the browser runtime, blueprint, site blueprint artifact, and Playground
version inputs.

Call `wp-codebox/get-browser-contained-site-status` with `cache_key` or `site_id`
plus `input_hash` or `source_digest` to check whether WP Codebox can recover the
prepared-runtime blueprint from its transient cache:

```json
{
  "success": true,
  "schema": "wp-codebox/browser-contained-site-status/v1",
  "site_id": "prepared-a1b2c3d4e5f6a7b8",
  "status": "recoverable",
  "blueprint_ref": {
    "schema": "wp-codebox/browser-blueprint-ref/v1",
    "ref": "prepared:prepared-a1b2c3d4e5f6a7b8:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

Status is idempotent and read-only. `recoverable` means the prepared runtime
transient exists and can hydrate a blueprint ref. `miss` means the caller should
create a new browser session from the same inputs. Durable ownership, UI state,
and retry policy still belong to the parent control plane.

## Browser Provider Adapter Contract

Browser sandbox calls that need parent-side connector authorization should use
the canonical `wp-codebox/browser-connector-request` ability. WP Codebox resolves
connector inheritance on the parent site, strips raw credential values, and
dispatches the request through Codebox's connector boundary.

| Ability | Trusted scope | Purpose |
| --- | --- | --- |
| `wp-codebox/create-browser-playground-session` | `browser-session:create` | Create a disposable browser Playground session and materialization contract. |
| `wp-codebox/browser-connector-request` | `browser-connector:request` | Resolve a connector-scoped request server-side with credentials kept in the connector runtime. |
| `wp-codebox/execute-browser-provider-request` | `browser-connector:request` | Legacy provider-adapter path with the provider-adapter response shape. Prefer `wp-codebox/browser-connector-request` for new connector-scoped browser calls unless this shape is required. |

Administrators with `manage_options` retain access to all three abilities. A
trusted orchestrator granted only `browser-session:create` can create browser
sessions, but cannot execute connector/provider requests.

```text
Browser connector bridge
  -> wp-codebox/browser-connector-request
    -> parent-side connector inheritance resolution
      -> connector/provider adapter owned by the host/control plane
```

`wp_codebox_browser_provider_request` is the internal adapter filter behind the
legacy provider-adapter path; it is not the consumer-facing API name.

The adapter filter receives a redacted request envelope:

```json
{
  "schema": "wp-codebox/browser-provider-adapter-request/v1",
  "operation": "chat.completions",
  "provider": "example-ai",
  "model": "example-model",
  "connector": {
    "name": "primary-ai",
    "status": "resolved",
    "provider": "example-ai",
    "model": "example-model"
  },
  "context": {
    "session_id": "browser-session-123",
    "caller": "trusted-orchestrator",
    "authorization_scope": "browser-connector:request"
  },
  "request": {}
}
```

Adapters return an array response envelope or `WP_Error`. If no adapter handles
the request, WP Codebox fails closed with
`wp_codebox_browser_provider_adapter_missing`. Returned success and error data is
redacted before WP Codebox exposes the normalized
`wp-codebox/browser-provider-adapter-response/v1` response.

WP Codebox core does not implement provider-specific execution here. Adapters
must resolve provider credentials server-side from their trusted connector
configuration. Raw provider keys must not be returned to browser JavaScript,
browser Playground PHP, artifacts, diagnostics, or audit metadata.

## Request Fields

`wp-codebox/run-agent-task` and `wp-codebox/run-agent-task-batch` accept these
optional correlation fields:

```json
{
  "sandbox_session_id": "external-job-123",
  "session_id": "sandbox-agent-conversation-456",
  "orchestrator": {
    "type": "external-job",
    "id": "parent-site-control-plane",
    "job_id": "123"
  }
}
```

- `sandbox_session_id` is caller-owned. WP Codebox echoes it in the response and
  does not persist it.
- `session_id` remains the in-sandbox agent conversation/session id passed to the
  mounted agent runtime.
- `orchestrator` is opaque correlation metadata for external job systems.

## Response Shape

The ability response includes a `wp-codebox/sandbox-session/v1` envelope:

```json
{
  "session": {
    "schema": "wp-codebox/sandbox-session/v1",
    "id": "external-job-123",
    "status": "completed",
    "persistence": "external-orchestrator",
    "agent_session_id": "sandbox-agent-conversation-456",
    "orchestrator": {
      "type": "external-job",
      "id": "parent-site-control-plane",
      "job_id": "123"
    },
    "artifacts": {
      "path": "/srv/artifacts/run-123",
      "bundle_id": "artifact-bundle-sha256-...",
      "preview_url": "https://preview.example.test/abc",
      "completion_outcome": "files/completion-outcome.json"
    }
  },
  "completion_outcome": {
    "schema": "wp-codebox/sandbox-completion-outcome/v1",
    "status": "succeeded",
    "summary": "Agent sandbox produced 2 changed files and a 1842-byte patch.",
    "changedFiles": {
      "count": 2,
      "paths": ["plugin.php", "tests/plugin-test.php"],
      "artifact": "files/changed-files.json"
    },
    "patch": {
      "bytes": 1842,
      "artifact": "files/patch.diff"
    },
    "verification": {
      "transcript": {
        "artifact": "files/transcript.json",
        "executionCount": 1
      },
      "commands": [
        { "command": "wp-codebox.agent-sandbox-run", "exitCode": 0 }
      ]
    },
    "blockers": [],
    "riskNotes": [],
    "confidence": "high",
    "nextAction": "promote",
    "provenance": {
      "artifactBundleId": "artifact-bundle-sha256-...",
      "artifactDirectory": "/srv/artifacts/run-123"
    }
  },
  "agent_result": {
    "schema": "wp-codebox/agent-result/v1",
    "status": "completed",
    "actionable": true,
    "summary": "Agent sandbox produced 2 changed files and a 1842-byte patch.",
    "changedFiles": {
      "count": 2,
      "paths": ["plugin.php", "tests/plugin-test.php"],
      "artifact": "files/changed-files.json"
    },
    "patch": {
      "bytes": 1842,
      "artifact": "files/patch.diff"
    },
    "transcript": {
      "artifact": "files/transcript.json",
      "executionCount": 1
    }
  }
}
```

The `status` field describes the synchronous WP Codebox call result. Durable
queued/running/cancelled/expired transitions belong to the external orchestrator.

## Agent Result Evidence

Agent sandbox recipe runs also write these additive artifact files:

- `files/completion-outcome.json` uses
  `wp-codebox/sandbox-completion-outcome/v1` and is the generic terminal
  contract for orchestration. It includes status (`succeeded`, `blocked`,
  `failed`, or `partial`), changed files, patch refs, verification command
  results, blockers, confidence/risk notes, next action, and artifact
  provenance.
- `files/agent-result.json` uses `wp-codebox/agent-result/v1` and summarizes
  actionability, changed-file count, patch bytes, transcript location, failures,
  no-op reason, and workspace-tool diagnostics.
- `files/transcript.json` uses `wp-codebox/agent-transcript/v1` and captures the
  bounded stdout/stderr plus parsed JSON for each `wp-codebox.agent-sandbox-run`
  workflow step.

The recipe-run JSON exposes the same compact `agentResult` object, and the host
WordPress ability mirrors it as `agent_result`. Empty patches and empty
`changed-files.json` are explicit non-actionable no-op results even when the
process exits successfully.

## External Orchestrator Responsibilities

- Store durable job/session state and user ownership.
- Enforce quotas, cancellation, concurrency, and retention.
- Decide whether to retry failed runs.
- Store links to returned artifact ids and preview URLs.
- Call WP Codebox artifact abilities for review, discard, or approved apply-back.

WP Codebox owns the sandbox run and artifact contract. It intentionally does not
own the parent site's job tables or product lifecycle UI.
