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

The host WP Codebox plugin should not depend on a specific parent job system.
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

## Browser Provider Adapter Contract

Browser Playground provider calls that need parent-side connector authorization
use the generic `wp-codebox/execute-browser-provider-request` ability. WP Codebox
resolves connector inheritance on the parent site, strips raw credential values,
and dispatches the request through the `wp_codebox_browser_provider_request`
filter.

```text
Browser connector bridge
  -> wp-codebox/execute-browser-provider-request
    -> parent-side connector inheritance resolution
      -> wp_codebox_browser_provider_request filter
        -> provider adapter owned by the host/control plane
```

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
    "authorization_scope": "browser-session:create"
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
