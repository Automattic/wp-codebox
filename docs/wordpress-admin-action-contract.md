# WordPress Admin Action Contract

`wordpress.admin-action` is the public destructive admin action contract for disposable WP Codebox runtimes.

The command executes only inside an explicit disposable destructive boundary:

```json
{
  "disposableRuntime": true,
  "destructive": true,
  "artifactPolicy": "capture",
  "teardown": "discard-runtime"
}
```

Supported action families:

- `admin-hook`: runs a declared admin hook with `do_action( hook )` after admin bootstrap.
- `ajax`: runs `do_action( "wp_ajax_" + action )` with declared request data.
- `admin-post`: runs `do_action( "admin_post_" + action )` with declared request data.

Descriptor-only families:

- `editor`: use `wordpress.editor-actions` for real browser-backed block editor mutations.
- `browser-random-walk`: the public planning contract exists in `browser-interaction`; runtime execution is unsupported until a real browser walker lands.

Example:

```json
{
  "schema": "wp-codebox/wordpress-admin-action/v1",
  "family": "admin-post",
  "action": "my_plugin_save_settings",
  "method": "POST",
  "body": { "enabled": "1" },
  "destructiveBoundary": {
    "disposableRuntime": true,
    "destructive": true,
    "artifactPolicy": "capture",
    "teardown": "discard-runtime"
  }
}
```

The result schema is `wp-codebox/wordpress-admin-action-result/v1` and includes `familyDescriptors`, `disposableDestructiveBoundary`, `executed`, `diagnostics`, `errors`, `artifacts`, `artifactRefs`, and a performance observation.
