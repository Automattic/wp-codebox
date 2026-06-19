# Agent Runtime Stack Probe

This example proves the intended guest application surface: a WordPress Playground sandbox with caller-supplied agent runtime components mounted and activated.

Set local checkout paths, then run the preset:

```bash
AGENTS_API_PATH=/path/to/agents-api \
RUNTIME_ENGINE_PATH=/path/to/runtime-engine \
RUNTIME_TOOLS_PATH=/path/to/runtime-tools \
PROVIDER_PLUGIN_PATH=/path/to/ai-provider-plugin \
npm run wp-codebox -- agent-runtime-probe \
  --component agents-api="$AGENTS_API_PATH" \
  --component runtime-engine="$RUNTIME_ENGINE_PATH" \
  --component runtime-tools="$RUNTIME_TOOLS_PATH" \
  --provider-plugin "$PROVIDER_PLUGIN_PATH" \
  --artifacts ./artifacts \
  --json
```

The preset mounts each `--component` at its declared slug, uses WordPress `7.0` by default, activates the plugins in dependency order, and returns a JSON readiness packet. It intentionally does not require provider credentials or model calls. Stack-specific shortcuts should be replaced with generic `--component` entries.
