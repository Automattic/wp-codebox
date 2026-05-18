# WP Codebox WordPress Plugin

Registers the WordPress ability surface for launching isolated WP Codebox
agent sandboxes from a parent site. The sandbox may produce WordPress-specific
or non-WordPress artifacts; the plugin returns the artifact bundle metadata to
the parent control plane for review, replay, or apply-back.

## Ability

- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`

The ability runs `wp-codebox agent-sandbox-run`, which boots a disposable
WordPress Playground runtime, mounts the agent stack components, invokes the
configured sandbox agent through the canonical `agents/chat` ability, and returns
artifact metadata.

The batch ability runs `wp-codebox agent-sandbox-batch`, accepts a list of
task descriptions, and launches one isolated sandbox per task with bounded
concurrency. This is the parent-site primitive for fan-out workflows such as
assigning several GitHub issues to separate sandbox coding agents.

Both abilities accept optional `provider` and `model` fields. These seed the
disposable sandbox's Data Machine agent configuration for the selected execution
mode. Provider plugins are supplied with `provider_plugin_paths`; WP Codebox
mounts and activates them without knowing provider-specific behavior. Provider
credentials continue to resolve through the provider's normal scoped mechanism.
Pass `secret_env` as a list of environment variable names to expose selected
parent process credentials inside the sandbox; values are read from the process
environment and are not accepted in the ability payload.

Returned artifact metadata includes the runtime manifest, replay blueprint,
after-state notes, captured readwrite mount index, event streams, and logs. WP
Codebox owns this capture boundary so the parent site can discard the disposable
sandbox while keeping durable evidence and outputs.

## Configuration

Component paths can be supplied by ability input, the
`wp_codebox_component_paths` option, or the `wp_codebox_component_paths`
filter.

Expected component keys:

- `agents_api`
- `data_machine`
- `data_machine_code`
- `provider_plugins` (optional list)

The CLI binary can be supplied by ability input, the `wp_codebox_bin` option,
or the `wp_codebox_bin` filter.

## Boundary

Data Machine Code is the mounted coding-tools component for file-editing agent
sandboxes. It provides workspace/file/GitHub tools inside the isolated runtime.
This plugin owns the parent-site ability surface and sandbox lifecycle boundary;
DMC does not own that control plane.

Data Machine, Data Machine Code, Homeboy Extensions, wp-gym, and other systems
are consumers or mounted tools. They do not own WP Codebox's artifact contract.
