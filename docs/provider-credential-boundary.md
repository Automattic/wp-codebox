# Provider Credential Boundary

WP Codebox exposes a generic provider credential lane so products can ask for a
provider/model without knowing the provider's raw credential storage, token
shape, refresh policy, or scoped authorization rules.

Provider-owned code declares requirements with
`wp_codebox_provider_credential_requirements` and resolves availability with
`wp_codebox_resolve_provider_credentials`. Both contracts are redacted. WP
Codebox accepts env var names and status diagnostics only; it never accepts,
prints, persists, or serializes secret values through these contracts.

```php
add_filter( 'wp_codebox_provider_credential_requirements', function ( $requirements, $selection ) {
	if ( 'example-provider' !== ( $selection['provider'] ?? '' ) ) {
		return $requirements;
	}

	$requirements['requirements'][] = array(
		'name'       => 'primary_api_token',
		'kind'       => 'api-token',
		'scope'      => 'sandbox-agent',
		'required'   => true,
		'secret_env' => array( 'EXAMPLE_PROVIDER_TOKEN' ),
	);

	return $requirements;
}, 10, 2 );

add_filter( 'wp_codebox_resolve_provider_credentials', function ( $preflight, $requirements ) {
	if ( 'example-provider' !== ( $requirements['provider'] ?? '' ) ) {
		return $preflight;
	}

	$preflight['status']     = getenv( 'EXAMPLE_PROVIDER_TOKEN' ) ? 'available' : 'missing';
	$preflight['secret_env'] = array( 'EXAMPLE_PROVIDER_TOKEN' );
	$preflight['diagnostics'][] = array(
		'code'     => 'example-token-env',
		'severity' => 'info',
		'message'  => 'Credential resolved through provider-owned env mapping.',
	);

	return $preflight;
}, 10, 2 );
```

Resolved runtime metadata uses `wp-codebox/provider-credential-resolution/v1`:

```json
{
  "schema": "wp-codebox/provider-credential-resolution/v1",
  "requirements": {
    "schema": "wp-codebox/provider-credential-requirements/v1",
    "provider": "example-provider",
    "requirements": [
      { "name": "primary_api_token", "required": true, "kind": "api-token", "scope": "sandbox-agent", "secretEnv": ["EXAMPLE_PROVIDER_TOKEN"] }
    ],
    "redacted": true
  },
  "preflight": {
    "schema": "wp-codebox/provider-credential-preflight/v1",
    "provider": "example-provider",
    "status": "available",
    "secret_env": ["EXAMPLE_PROVIDER_TOKEN"],
    "diagnostics": [],
    "redacted": true
  },
  "secret_env": ["EXAMPLE_PROVIDER_TOKEN"],
  "redacted": true
}
```

Contract rules:

- `available` allows the sandbox to proceed and merges declared env names into
  the sandbox secret-env allowlist.
- `missing` and `denied` fail closed before sandbox launch.
- `not-required` is the default when no provider requirement hook participates.
- Diagnostics should describe requirement names, scopes, and safe status only.
- Raw values stay in provider-owned storage or process env and are never part of
  requirement, preflight, runtime plan, artifact, or log output.
