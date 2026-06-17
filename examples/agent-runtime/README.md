# Agent Runtime Stack Probe

This example proves the intended guest application surface: a WordPress Playground sandbox with caller-supplied agent runtime components mounted and activated.

Set local checkout paths, then run the preset:

```bash
AGENTS_API_PATH=/path/to/agents-api \
DATA_MACHINE_PATH=/path/to/data-machine \
DATA_MACHINE_CODE_PATH=/path/to/data-machine-code \
PROVIDER_PLUGIN_PATH=/path/to/ai-provider-plugin \
npm run wp-codebox -- agent-runtime-probe \
  --component agents-api="$AGENTS_API_PATH" \
  --component data-machine="$DATA_MACHINE_PATH" \
  --component data-machine-code="$DATA_MACHINE_CODE_PATH" \
  --provider-plugin "$PROVIDER_PLUGIN_PATH" \
  --artifacts ./artifacts \
  --json
```

The preset mounts each `--component` at its declared slug, uses WordPress `7.0` by default, activates the plugins in dependency order, and returns a JSON readiness packet. It intentionally does not require provider credentials or model calls. Legacy stack-specific flags such as `--agents-api` still work as compatibility aliases; new examples should prefer generic `--component` entries.
