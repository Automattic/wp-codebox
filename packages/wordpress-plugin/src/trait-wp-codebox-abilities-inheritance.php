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
	return WP_Codebox_Browser_Task_Builder::normalize_task_input( $input, fn( array $tools, array $task_input ): WP_Error|null => ( new WP_Codebox_Agent_Sandbox_Runner() )->validate_allowed_tools( $tools, $task_input ) );
}

/** @param array<string,mixed> $input Ability input. @return array{connectors:string[],settings:string[]} */
private static function browser_inheritance_request( array $input ): array {
	return WP_Codebox_Inheritance::request( $input );
}

/** @param array<string,mixed> $input Ability input. @return array{inheritance:array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>}}|WP_Error */
private static function browser_inheritance_resolution_payload( array $input ): array|WP_Error {
	$payload     = WP_Codebox_Inheritance::resolution_payload( $input, static fn( string $path ): string => self::browser_clean_path( $path ) );
	$inheritance = $payload['inheritance'];
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
	return WP_Codebox_Browser_Task_Builder::task_payload(
		$input,
		$task_input,
		$session_id,
		$artifacts,
		$inheritance,
		array(
			'runtime_dependency_plan' => static function ( array $input, array $task_input, array $inheritance ): WP_Codebox_Runtime_Dependency_Plan {
				return new WP_Codebox_Runtime_Dependency_Plan(
					array(
						'agent'    => self::browser_agent_slug( $input ),
						'mode'     => self::browser_mode( $input ),
						'provider' => self::browser_provider( $input, $inheritance ),
						'model'    => self::browser_model( $input, $inheritance ),
					),
					self::browser_provider_plugin_paths( $input ),
					array(),
					array(),
					is_array( $input['runtime_overlays'] ?? null ) ? $input['runtime_overlays'] : array(),
					$inheritance,
					self::browser_inheritance_request( $input ),
					self::normalize_agent_bundles( $input['agent_bundles'] ?? array() ),
					self::browser_secret_env_names( $input )
				);
			},
			'agent'         => static fn( array $input ): string => self::browser_agent_slug( $input ),
			'mode'          => static fn( array $input ): string => self::browser_mode( $input ),
			'provider'      => static fn( array $input, array $task_input, array $inheritance ): string => self::browser_provider( $input, $inheritance ),
			'model'         => static fn( array $input, array $task_input, array $inheritance ): string => self::browser_model( $input, $inheritance ),
			'agent_bundles' => static fn( array $input ): array => self::normalize_agent_bundles( $input['agent_bundles'] ?? array() ),
			'secret_env'    => static fn( array $input ): array => self::browser_secret_env_names( $input ),
		)
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
		if ( is_array( $bundle['import_principal'] ?? null ) ) {
			$entry['import_principal'] = self::normalize_agent_bundle_import_principal( $bundle['import_principal'] );
		}

		$normalized[] = $entry;
	}

	return $normalized;
}

/** @param array<string,mixed> $principal Raw import principal. @return array<string,mixed> */
private static function normalize_agent_bundle_import_principal( array $principal ): array {
	$normalized = array();
	foreach ( array( 'agent_id', 'owner_id', 'token_id' ) as $field ) {
		if ( isset( $principal[ $field ] ) && (int) $principal[ $field ] > 0 ) {
			$normalized[ $field ] = (int) $principal[ $field ];
		}
	}

	$capabilities = self::string_list( $principal['capabilities'] ?? array() );
	if ( ! empty( $capabilities ) ) {
		$normalized['capabilities'] = $capabilities;
	}

	if ( is_array( $principal['scope'] ?? null ) ) {
		$scope = array();
		foreach ( array( 'scope', 'label' ) as $field ) {
			$value = isset( $principal['scope'][ $field ] ) ? trim( (string) $principal['scope'][ $field ] ) : '';
			if ( '' !== $value ) {
				$scope[ $field ] = $value;
			}
		}
		foreach ( array( 'ability_categories', 'ability_allow', 'ability_deny', 'capabilities' ) as $field ) {
			$values = self::string_list( $principal['scope'][ $field ] ?? array() );
			if ( ! empty( $values ) ) {
				$scope[ $field ] = $values;
			}
		}
		if ( ! empty( $scope ) ) {
			$normalized['scope'] = $scope;
		}
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
	return WP_Codebox_Inheritance::secret_env_names( $inheritance );
}

/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
private static function browser_connector_credentials_error( array $inheritance ): WP_Error|null {
	return WP_Codebox_Inheritance::connector_credentials_error( $inheritance, 'Requested connector credentials are missing or denied for this browser sandbox scope.' );
}

/** @return string[] */
private static function string_list( mixed $value ): array {
	return WP_Codebox_Agent_Task::string_list( $value );
}
}
