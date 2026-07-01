# Cache Churn Observation Contract

`wordpress.cache-churn-observation` executes one in-process WordPress REST request and emits `wp-codebox/cache-churn-observation/v1`.

The observation is product-neutral and intended for destructive fuzzing runs that need to correlate a case/action with cache, transient, and option churn.

## Command

Required arguments:

- `path=<rest-route>`: REST route with or without `/wp-json`.

Optional arguments:

- `method=<HTTP method>`: defaults to `GET`.
- `params-json=<object>`: request params passed to `WP_REST_Request::set_param()`.
- `user=<fixture user>` or `session=<fixture session>`: fixture auth context.
- `sample-limit=<positive integer>`: maximum names emitted per section. Defaults to `100`.
- `case-id=<id>`, `action-id=<id>`, `correlation-id=<id>`: copied into `correlation`.

## Output

The output includes:

- `schema`: `wp-codebox/cache-churn-observation/v1`.
- `artifactKind`: `cache-churn-observation`.
- `transients`: transient get/set/delete counts and bounded name samples.
- `siteTransients`: site transient get/set/delete counts and bounded name samples.
- `options`: option get/add/update/delete counts, bounded option name samples, and autoload key churn.
- `objectCache`: explicit support status. WordPress core cache functions do not emit product-neutral operation hooks, so object-cache operation counts are reported as unsupported with a reason instead of inferred from internals.
- `correlation`: optional case/action/run identifiers.

The fuzz runtime descriptor advertises this artifact as optional evidence under `cache-churn-observation` and exposes the schema id for HBEX consumers.
