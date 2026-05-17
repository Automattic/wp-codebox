# Agent Runtime Stack Probe

This example proves the intended guest application surface: a WordPress Playground sandbox with the agent runtime stack mounted and activated.

Set local checkout paths, then run:

```bash
AGENTS_API_PATH=/path/to/agents-api \
DATA_MACHINE_PATH=/path/to/data-machine \
DATA_MACHINE_CODE_PATH=/path/to/data-machine-code \
OPENAI_PROVIDER_PATH=/path/to/ai-provider-for-openai \
npm run sandbox-runtime -- run \
  --wp trunk \
  --mount "$AGENTS_API_PATH:/wordpress/wp-content/plugins/agents-api" \
  --mount "$DATA_MACHINE_PATH:/wordpress/wp-content/plugins/data-machine" \
  --mount "$DATA_MACHINE_CODE_PATH:/wordpress/wp-content/plugins/data-machine-code" \
  --mount "$OPENAI_PROVIDER_PATH:/wordpress/wp-content/plugins/ai-provider-for-openai" \
  --command wordpress.run-php \
  --arg code-file=./examples/agent-runtime/probe.php \
  --artifacts ./artifacts \
  --json
```

The probe activates the mounted plugins in dependency order and returns a JSON readiness packet. It intentionally does not require provider credentials or model calls.
