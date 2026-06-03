<?php
/**
 * WP_Codebox_Abilities_Inheritance implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Inheritance {
/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
private static function normalize_task_input( array $input ): array|WP_Error {
	return WP_Codebox_Agent_Task::normalize_input( $input, fn( array $tools ): WP_Error|null => ( new WP_Codebox_Agent_Sandbox_Runner() )->validate_allowed_tools( $tools ), true );
}

/** @param array<string,mixed> $input Ability input. @return array{connectors:string[],settings:string[]} */
private static function browser_inheritance_request( array $input ): array {
	$inherit = is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array();

	return array(
		'connectors' => self::string_list( $inherit['connectors'] ?? array() ),
		'settings'   => self::string_list( $inherit['settings'] ?? array() ),
	);
}

/** @param array<string,mixed> $input Ability input. @return array{inheritance:array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>}}|WP_Error */
private static function browser_inheritance_resolution_payload( array $input ): array|WP_Error {
	$request    = self::browser_inheritance_request( $input );
	$resolution = array(
		'connectors' => array_map(
			static fn( string $name ): array => array(
				'name'   => $name,
				'status' => 'unresolved',
			),
			$request['connectors']
		),
		'settings'   => array_map(
			static fn( string $name ): array => array(
				'name'   => $name,
				'status' => 'unresolved',
			),
			$request['settings']
		),
	);

	if ( function_exists( 'apply_filters' ) && ( ! empty( $request['connectors'] ) || ! empty( $request['settings'] ) ) ) {
		$filtered = apply_filters( 'wp_codebox_resolve_inheritance', $resolution, $request, $input );
		if ( is_array( $filtered ) ) {
			$resolution = $filtered;
		}
	}

	$inheritance = array(
		'connectors' => self::sanitize_browser_inheritance_connectors( $resolution['connectors'] ?? array() ),
		'settings'   => self::sanitize_browser_inheritance_settings( $resolution['settings'] ?? array() ),
	);
	$credential_error = self::browser_connector_credentials_error( $inheritance );
	if ( null !== $credential_error ) {
		return $credential_error;
	}

	return array( 'inheritance' => $inheritance );
}

/** @param array<string,mixed> $input Ability input. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance @return array<string,mixed> */
private static function browser_input_with_inheritance( array $input, array $inheritance ): array {
	$input['provider_plugin_paths'] = array_values( array_unique( array_merge( self::browser_provider_plugin_paths( $input ), self::browser_inheritance_provider_plugin_paths( $inheritance ) ) ) );
	$input['secret_env']            = array_values( array_unique( array_merge( self::browser_secret_env_names( $input ), self::browser_inheritance_secret_env_names( $inheritance ) ) ) );

	return $input;
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $task_input Normalized task input. @param array<int,array<string,mixed>> $artifacts Browser artifact specs. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance @return array<string,mixed> */
private static function browser_task_payload( array $input, array $task_input, string $session_id, array $artifacts, array $inheritance ): array {
	return array_filter(
		array(
			'schema'      => 'wp-codebox/browser-agent-task-payload/v1',
			'agent'       => self::browser_agent_slug( $input ),
			'mode'        => self::browser_mode( $input ),
			'provider'    => self::browser_provider( $input, $inheritance ),
			'model'       => self::browser_model( $input, $inheritance ),
			'message'     => (string) $task_input['goal'],
			'session_id'  => $session_id,
			'task_input'  => $task_input,
			'agent_bundles' => self::normalize_agent_bundles( $input['agent_bundles'] ?? $input['agentBundles'] ?? array() ),
			'inheritance' => $inheritance,
			'secret_env'  => self::browser_secret_env_names( $input ),
			'artifacts'   => array(
				'schema' => 'wp-codebox/browser-artifacts/v1',
				'files'  => $artifacts,
			),
		),
		static fn( mixed $value ): bool => '' !== $value && array() !== $value
	);
}

/** @param array<string,mixed> $input Ability input. */
private static function browser_agent_slug( array $input ): string {
	$agent = trim( (string) ( $input['agent'] ?? '' ) );
	if ( '' === $agent && function_exists( 'apply_filters' ) ) {
		$agent = (string) apply_filters( 'wp_codebox_default_agent', '' );
	}

	return '' !== trim( $agent ) ? trim( $agent ) : 'wp-codebox-sandbox';
}

/** @param array<string,mixed> $input Ability input. */
private static function browser_mode( array $input ): string {
	$mode = trim( (string) ( $input['mode'] ?? '' ) );
	return '' !== $mode ? $mode : 'sandbox';
}

/** @param array<string,mixed> $input Ability input. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
private static function browser_provider( array $input, array $inheritance ): string {
	$provider = trim( (string) ( $input['provider'] ?? '' ) );
	if ( '' !== $provider ) {
		return $provider;
	}

	foreach ( $inheritance['connectors'] as $connector ) {
		$provider = trim( (string) ( $connector['provider'] ?? '' ) );
		if ( '' !== $provider ) {
			return $provider;
		}
	}

	return function_exists( 'apply_filters' ) ? trim( (string) apply_filters( 'wp_codebox_default_provider', '' ) ) : '';
}

/** @param array<string,mixed> $input Ability input. @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
private static function browser_model( array $input, array $inheritance ): string {
	$model = trim( (string) ( $input['model'] ?? '' ) );
	if ( '' !== $model ) {
		return $model;
	}

	foreach ( $inheritance['connectors'] as $connector ) {
		$model = trim( (string) ( $connector['model'] ?? '' ) );
		if ( '' !== $model ) {
			return $model;
		}
	}

	return function_exists( 'apply_filters' ) ? trim( (string) apply_filters( 'wp_codebox_default_model', '' ) ) : '';
}

/** @param array<string,mixed> $input Ability input. @return string[] */
private static function browser_provider_plugin_paths( array $input ): array {
	return array_values( array_unique( array_filter( array_map( static fn( $path ): string => self::browser_clean_path( (string) $path ), is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : array() ), static fn( string $path ): bool => '' !== $path && is_dir( $path ) ) ) );
}

/** @param array<string,mixed> $input Ability input. @return string[] */
private static function browser_secret_env_names( array $input ): array {
	return array_values( array_unique( array_filter( self::string_list( $input['secret_env'] ?? array() ), static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) ) );
}

/** @return array<int,array<string,mixed>> */
private static function normalize_agent_bundles( mixed $bundles ): array {
	$normalized = array();
	foreach ( is_array( $bundles ) ? $bundles : array() as $bundle ) {
		if ( ! is_array( $bundle ) ) {
			continue;
		}
		$source = isset( $bundle['source'] ) ? trim( (string) $bundle['source'] ) : '';
		$inline = is_array( $bundle['bundle'] ?? null ) ? $bundle['bundle'] : null;
		if ( '' === $source && null === $inline ) {
			continue;
		}

		$entry = array();
		if ( '' !== $source ) {
			$entry['source'] = $source;
		}
		if ( null !== $inline ) {
			$entry['bundle'] = $inline;
		}
		foreach ( array( 'slug', 'token_env' ) as $field ) {
			$value = isset( $bundle[ $field ] ) ? trim( (string) $bundle[ $field ] ) : '';
			if ( '' !== $value ) {
				$entry[ $field ] = $value;
			}
		}
		$on_conflict = (string) ( $bundle['on_conflict'] ?? 'upgrade' );
		$entry['on_conflict'] = in_array( $on_conflict, array( 'error', 'skip', 'upgrade' ), true ) ? $on_conflict : 'upgrade';
		if ( isset( $bundle['owner_id'] ) && (int) $bundle['owner_id'] > 0 ) {
			$entry['owner_id'] = (int) $bundle['owner_id'];
		}

		$normalized[] = $entry;
	}

	return $normalized;
}

/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance @return string[] */
private static function browser_inheritance_provider_plugin_paths( array $inheritance ): array {
	$paths = array();
	foreach ( $inheritance['connectors'] as $connector ) {
		$paths = array_merge( $paths, self::string_list( $connector['providerPluginPaths'] ?? array() ) );
	}

	return array_values( array_unique( $paths ) );
}

/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance @return string[] */
private static function browser_inheritance_secret_env_names( array $inheritance ): array {
	$names = array();
	foreach ( $inheritance['connectors'] as $connector ) {
		$names = array_merge( $names, self::string_list( $connector['secretEnv'] ?? array() ) );
		$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
		foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
			if ( is_array( $secret ) && 'available' === ( $secret['status'] ?? '' ) ) {
				$names[] = (string) ( $secret['name'] ?? '' );
			}
		}
	}

	return array_values( array_unique( array_filter( $names ) ) );
}

/** @param array<int,mixed> $connectors Inheritance connector rows. @return array<int,array<string,mixed>> */
private static function sanitize_browser_inheritance_connectors( array $connectors ): array {
	$sanitized = array();
	foreach ( $connectors as $connector ) {
		if ( ! is_array( $connector ) ) {
			continue;
		}

		$name = trim( (string) ( $connector['name'] ?? '' ) );
		if ( '' === $name ) {
			continue;
		}

		$entry = array(
			'name'   => $name,
			'status' => trim( (string) ( $connector['status'] ?? 'resolved' ) ),
		);
		foreach ( array( 'provider', 'model' ) as $field ) {
			$value = trim( (string) ( $connector[ $field ] ?? '' ) );
			if ( '' !== $value ) {
				$entry[ $field ] = $value;
			}
		}

		$provider_plugin_paths = array_values( array_filter( array_map( static fn( string $path ): string => self::browser_clean_path( $path ), self::string_list( $connector['provider_plugin_paths'] ?? $connector['providerPluginPaths'] ?? array() ) ), static fn( string $path ): bool => '' !== $path && is_dir( $path ) ) );
		if ( ! empty( $provider_plugin_paths ) ) {
			$entry['providerPluginPaths'] = array_values( array_unique( $provider_plugin_paths ) );
		}

		$secret_env = array_values( array_filter( self::string_list( $connector['secret_env'] ?? $connector['secretEnv'] ?? array() ), static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) );
		if ( ! empty( $secret_env ) ) {
			$entry['secretEnv'] = array_values( array_unique( $secret_env ) );
		}

		$credentials = self::sanitize_browser_connector_credentials( $connector['credentials'] ?? null, $name );
		if ( ! empty( $credentials ) ) {
			$entry['credentials'] = $credentials;
		}

		$sanitized[] = $entry;
	}

	return $sanitized;
}

/** @return array<string,mixed> */
private static function sanitize_browser_connector_credentials( mixed $credentials, string $connector_name ): array {
	if ( ! is_array( $credentials ) ) {
		return array();
	}

	$status = self::browser_credential_status( (string) ( $credentials['status'] ?? 'missing' ) );
	$entry  = array(
		'schema'    => 'wp-codebox/connector-credentials/v1',
		'connector' => $connector_name,
		'scope'     => 'connector',
		'status'    => $status,
		'secrets'   => array(),
	);
	$reason = self::browser_redacted_reason( $credentials['reason'] ?? '' );
	if ( '' !== $reason ) {
		$entry['reason'] = $reason;
	}

	foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
		if ( ! is_array( $secret ) ) {
			continue;
		}

		$name = trim( (string) ( $secret['name'] ?? '' ) );
		if ( 1 !== preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
			continue;
		}

		$secret_entry = array(
			'name'   => $name,
			'status' => self::browser_credential_status( (string) ( $secret['status'] ?? $status ) ),
		);
		foreach ( array( 'scope', 'source', 'reason' ) as $field ) {
			$value = 'reason' === $field ? self::browser_redacted_reason( $secret[ $field ] ?? '' ) : trim( (string) ( $secret[ $field ] ?? '' ) );
			if ( '' !== $value ) {
				$secret_entry[ $field ] = $value;
			}
		}

		$entry['secrets'][] = $secret_entry;
	}

	return $entry;
}

private static function browser_credential_status( string $status ): string {
	return in_array( $status, array( 'available', 'missing', 'denied' ), true ) ? $status : 'missing';
}

private static function browser_redacted_reason( mixed $reason ): string {
	$reason = trim( (string) $reason );
	return '' === $reason ? '' : substr( preg_replace( '/[^A-Za-z0-9 .:_-]/', '', $reason ) ?? '', 0, 160 );
}

/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
private static function browser_connector_credentials_error( array $inheritance ): WP_Error|null {
	$failures = array();
	foreach ( $inheritance['connectors'] as $connector ) {
		$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
		if ( empty( $credentials ) ) {
			continue;
		}

		$status  = (string) ( $credentials['status'] ?? 'missing' );
		$secrets = array_filter( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array(), static fn( mixed $secret ): bool => is_array( $secret ) && in_array( (string) ( $secret['status'] ?? '' ), array( 'missing', 'denied' ), true ) );
		if ( in_array( $status, array( 'missing', 'denied' ), true ) || ! empty( $secrets ) ) {
			$failures[] = array(
				'name'        => (string) ( $connector['name'] ?? '' ),
				'status'      => (string) ( $connector['status'] ?? '' ),
				'credentials' => $credentials,
			);
		}
	}

	return empty( $failures ) ? null : new WP_Error( 'wp_codebox_connector_credentials_unavailable', 'Requested connector credentials are missing or denied for this browser sandbox scope.', array( 'status' => 403, 'schema' => 'wp-codebox/connector-credential-failure/v1', 'connectors' => $failures ) );
}

/** @param array<int,mixed> $settings Inheritance setting rows. @return array<int,array<string,mixed>> */
private static function sanitize_browser_inheritance_settings( array $settings ): array {
	$sanitized = array();
	foreach ( $settings as $setting ) {
		if ( ! is_array( $setting ) ) {
			continue;
		}
		$name = trim( (string) ( $setting['name'] ?? '' ) );
		if ( '' === $name ) {
			continue;
		}
		$entry = array(
			'name'   => $name,
			'status' => trim( (string) ( $setting['status'] ?? 'resolved' ) ),
		);
		$scope = trim( (string) ( $setting['scope'] ?? '' ) );
		if ( '' !== $scope ) {
			$entry['scope'] = $scope;
		}
		$sanitized[] = $entry;
	}

	return $sanitized;
}

/** @return string[] */
private static function string_list( mixed $value ): array {
	return WP_Codebox_Agent_Task::string_list( $value );
}
}
