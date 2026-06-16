# Runtime Component Lifecycle

WP Codebox runtime tasks may load component entries after WordPress has already booted. To keep component behavior deterministic, Codebox replays the runtime component lifecycle before agent execution:

1. `plugins_loaded`
2. `init`
3. `wp_abilities_api_categories_init`
4. `wp_abilities_api_init`
5. `wp_codebox_runtime_abilities_ready`

Components should use WordPress' ability hooks to register ability categories and abilities. Components that expose model-facing tools derived from registered abilities should attach that projection to `wp_codebox_runtime_abilities_ready` so all ability registration has completed first.

Runtime diagnostics include the observed `did_action()` counts for these hooks where the runtime surface returns structured lifecycle diagnostics.
