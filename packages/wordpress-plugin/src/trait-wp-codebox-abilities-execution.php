<?php
/**
 * WP_Codebox_Abilities_Execution implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Execution {
/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_agent_task( array $input ): array|WP_Error {
	return ( new WP_Codebox_Agent_Sandbox_Runner() )->run( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function run_agent_task_batch( array $input ): array|WP_Error {
	return ( new WP_Codebox_Agent_Sandbox_Runner() )->run_batch( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_playground_session( array $input ): array|WP_Error {
	$task_input = self::normalize_task_input( $input );
	if ( is_wp_error( $task_input ) ) {
		return $task_input;
	}

	$session_id = trim( (string) ( $input['sandbox_session_id'] ?? $input['session_id'] ?? '' ) );
	if ( '' === $session_id ) {
		$session_id = self::generate_id();
	}

	$playground = self::browser_playground( $input );
	if ( is_wp_error( $playground ) ) {
		return $playground;
	}

	$inheritance_payload = self::browser_inheritance_resolution_payload( $input );
	if ( is_wp_error( $inheritance_payload ) ) {
		return $inheritance_payload;
	}
	$input           = self::browser_input_with_inheritance( $input, $inheritance_payload['inheritance'] );
	$browser_runner  = is_array( $input['browser_runner'] ?? null ) ? $input['browser_runner'] : array();
	$legacy_plugins  = self::browser_plugins( $input );
	if ( is_wp_error( $legacy_plugins ) ) {
		return $legacy_plugins;
	}
	$runtime = self::browser_runtime_dependencies( $input, $legacy_plugins );
	if ( is_wp_error( $runtime ) ) {
		return $runtime;
	}
	$browser_plugins = $runtime['plugins'];

	$site_blueprint_artifact = self::browser_site_blueprint_artifact( $input );
	if ( is_wp_error( $site_blueprint_artifact ) ) {
		return $site_blueprint_artifact;
	}

	$base_blueprint = self::browser_blueprint_with_site_artifact( is_array( $input['blueprint'] ?? null ) ? $input['blueprint'] : array(), $site_blueprint_artifact );
	$blueprint      = self::browser_blueprint_with_runtime( $base_blueprint, $runtime, $playground );
	$artifacts      = self::browser_artifact_files( $input );
	if ( is_wp_error( $artifacts ) ) {
		return $artifacts;
	}
	$ready_to_code = self::browser_ready_to_code_signal( $input, $runtime );
	if ( false === ( $ready_to_code['emitted'] ?? false ) ) {
		return self::blocked_browser_playground_session( $session_id, $input, $task_input, $ready_to_code, $browser_plugins, $runtime, $artifacts, $playground, $blueprint, $site_blueprint_artifact );
	}

	$task_payload = self::browser_task_payload( $input, $task_input, $session_id, $artifacts, $inheritance_payload['inheritance'] );
	$recipe = self::browser_agent_recipe( $task_input, $session_id, $browser_runner, $blueprint, $playground, $task_payload );
	if ( is_wp_error( $recipe ) ) {
		return $recipe;
	}
	$materialization = self::browser_materialization_contract( $recipe );

	return array(
		'success'          => true,
		'schema'           => 'wp-codebox/browser-playground-session/v1',
		'execution'        => 'browser-playground',
		'execution_scope'  => 'disposable-playground',
		'permission_model' => 'runtime-principal',
		'session'          => self::browser_session_envelope( $session_id, 'ready', $input ),
		'task'             => (string) $task_input['goal'],
		'task_input' => $task_input,
		'task_payload' => $task_payload,
		'agent'      => (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
		'provider'   => self::browser_provider( $input, $inheritance_payload['inheritance'] ),
		'model'      => self::browser_model( $input, $inheritance_payload['inheritance'] ),
		'inheritance' => $inheritance_payload['inheritance'],
		'plugins'    => $browser_plugins,
		'runtime'    => $runtime,
		'site_blueprint_artifact' => $site_blueprint_artifact,
		'materialization' => $materialization,
		'playground' => array(
			'client_module_url'  => $playground['client_module_url'],
			'remote_url'         => $playground['remote_url'],
			'cors_proxy_url'     => $playground['cors_proxy_url'],
			'scope'              => (string) ( $playground['scope'] ?? $session_id ),
			'artifact_base_path' => self::browser_artifact_base_path( $playground ),
			'artifact_base_url'  => self::browser_artifact_base_url( $playground ),
			'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
			'blueprint'          => self::browser_playground_blueprint( $blueprint, $playground ),
			'capabilities'       => array(
				'compile_blueprint' => true,
				'run_blueprint'     => true,
				'write_file'        => true,
				'run_php'           => true,
			),
			'provenance'         => $playground['provenance'],
		),
		'recipe'     => $recipe,
		'signals'    => array(
			'ready_to_code' => $ready_to_code,
		),
		'artifacts'  => array(
			'schema'             => 'wp-codebox/browser-artifacts/v1',
			'files'              => $artifacts,
			'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
			'expected_artifacts' => $task_input['expected_artifacts'],
		),
	);
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_materializer_contract( array $input ): array|WP_Error {
	$session = self::create_browser_playground_session( $input );
	if ( is_wp_error( $session ) ) {
		return $session;
	}

	if ( true !== ( $session['success'] ?? false ) ) {
		$session_envelope = is_array( $session['session'] ?? null ) ? $session['session'] : array();
		$contract         = array_filter(
			array(
				'success'          => false,
				'schema'           => 'wp-codebox/browser-materializer-contract/v1',
				'execution'        => 'browser-playground',
				'execution_scope'  => 'disposable-playground',
				'permission_model' => 'runtime-principal',
				'status'           => (string) ( $session['status'] ?? 'blocked' ),
				'error'            => is_array( $session['error'] ?? null ) ? $session['error'] : array(),
				'session_id'       => (string) ( $session_envelope['id'] ?? '' ),
				'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : self::browser_session_authorization( $input ),
				'signals'          => is_array( $session['signals'] ?? null ) ? $session['signals'] : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
		$contract['compact'] = self::compact_browser_materializer_contract_dto( $contract );

		return $contract;
	}

	$session_envelope = is_array( $session['session'] ?? null ) ? $session['session'] : array();

	$contract = array(
		'success'          => true,
		'schema'           => 'wp-codebox/browser-materializer-contract/v1',
		'execution'        => 'browser-playground',
		'execution_scope'  => 'disposable-playground',
		'permission_model' => 'runtime-principal',
		'session_id'       => (string) ( $session_envelope['id'] ?? '' ),
		'authorization'    => is_array( $session_envelope['authorization'] ?? null ) ? $session_envelope['authorization'] : self::browser_session_authorization( $input ),
		'task_input'       => is_array( $session['task_input'] ?? null ) ? $session['task_input'] : array(),
		'task_payload'     => is_array( $session['task_payload'] ?? null ) ? $session['task_payload'] : array(),
		'materialization'  => is_array( $session['materialization'] ?? null ) ? $session['materialization'] : array(),
		'recipe'           => is_array( $session['recipe'] ?? null ) ? $session['recipe'] : array(),
		'playground'       => is_array( $session['playground'] ?? null ) ? $session['playground'] : array(),
		'runtime'          => is_array( $session['runtime'] ?? null ) ? $session['runtime'] : array(),
		'artifacts'        => is_array( $session['artifacts'] ?? null ) ? $session['artifacts'] : array(),
		'provenance'       => array(
			'generated_by' => 'wp-codebox/browser-materializer-contract',
			'source'       => 'wp-codebox/create-browser-playground-session',
		),
	);
	$contract['compact'] = self::compact_browser_materializer_contract_dto( $contract );

	return $contract;
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function create_browser_task_contract( array $input ): array|WP_Error {
	$primary = self::create_browser_playground_session( $input );
	if ( is_wp_error( $primary ) ) {
		return $primary;
	}

	$session_envelope = is_array( $primary['session'] ?? null ) ? $primary['session'] : array();
	if ( true !== ( $primary['success'] ?? false ) ) {
		$contract = array_filter(
			array(
				'success'          => false,
				'schema'           => 'wp-codebox/browser-task-contract/v1',
				'execution'        => 'browser-playground',
				'execution_scope'  => 'disposable-playground',
				'permission_model' => 'runtime-principal',
				'status'           => (string) ( $primary['status'] ?? 'blocked' ),
				'error'            => is_array( $primary['error'] ?? null ) ? $primary['error'] : array(),
				'session'          => $session_envelope,
				'primary'          => $primary,
				'phases'           => array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
		$contract['compact'] = self::compact_browser_task_contract_dto( $contract );

		return $contract;
	}

	$phases = self::browser_task_contract_phases( $input, $session_envelope );
	if ( is_wp_error( $phases ) ) {
		return $phases;
	}

	$contract = array(
		'success'          => true,
		'schema'           => 'wp-codebox/browser-task-contract/v1',
		'execution'        => 'browser-playground',
		'execution_scope'  => 'disposable-playground',
		'permission_model' => 'runtime-principal',
		'session'          => $session_envelope,
		'primary'          => $primary,
		'phases'           => $phases,
		'provenance'       => array(
			'generated_by' => 'wp-codebox/browser-task-contract',
			'source'       => 'wp-codebox/create-browser-playground-session',
		),
	);
	$contract['compact'] = self::compact_browser_task_contract_dto( $contract );

	return $contract;
}

/** @param array<string,mixed> $contract Browser task contract. @return array<string,mixed> */
private static function compact_browser_task_contract_dto( array $contract ): array {
	$phases = array();
	foreach ( is_array( $contract['phases'] ?? null ) ? $contract['phases'] : array() as $phase ) {
		if ( ! is_array( $phase ) ) {
			continue;
		}

		$phase_dto = array(
			'name'  => (string) ( $phase['name'] ?? '' ),
			'kind'  => (string) ( $phase['kind'] ?? '' ),
			'index' => (int) ( $phase['index'] ?? 0 ),
		);
		if ( is_array( $phase['contract'] ?? null ) ) {
			$phase_dto['contract'] = self::compact_browser_materializer_contract_dto( $phase['contract'] );
		}

		$phases[] = array_filter( $phase_dto, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
	}

	return array_filter(
		array(
			'success'          => (bool) ( $contract['success'] ?? false ),
			'schema'           => 'wp-codebox/browser-task-product-dto/v1',
			'source_schema'    => (string) ( $contract['schema'] ?? '' ),
			'execution'        => (string) ( $contract['execution'] ?? '' ),
			'execution_scope'  => (string) ( $contract['execution_scope'] ?? '' ),
			'permission_model' => (string) ( $contract['permission_model'] ?? '' ),
			'status'           => (string) ( $contract['status'] ?? '' ),
			'error'            => is_array( $contract['error'] ?? null ) ? self::compact_browser_dto_value( $contract['error'] ) : array(),
			'session'          => is_array( $contract['session'] ?? null ) ? self::compact_browser_dto_value( $contract['session'] ) : array(),
			'primary'          => is_array( $contract['primary'] ?? null ) ? self::compact_browser_session_dto( $contract['primary'] ) : array(),
			'phases'           => $phases,
			'provenance'       => is_array( $contract['provenance'] ?? null ) ? self::compact_browser_dto_value( $contract['provenance'] ) : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $contract Browser materializer contract. @return array<string,mixed> */
private static function compact_browser_materializer_contract_dto( array $contract ): array {
	return array_filter(
		array(
			'success'          => (bool) ( $contract['success'] ?? false ),
			'schema'           => 'wp-codebox/browser-materializer-product-dto/v1',
			'source_schema'    => (string) ( $contract['schema'] ?? '' ),
			'execution'        => (string) ( $contract['execution'] ?? '' ),
			'execution_scope'  => (string) ( $contract['execution_scope'] ?? '' ),
			'permission_model' => (string) ( $contract['permission_model'] ?? '' ),
			'status'           => (string) ( $contract['status'] ?? '' ),
			'error'            => is_array( $contract['error'] ?? null ) ? self::compact_browser_dto_value( $contract['error'] ) : array(),
			'session_id'       => (string) ( $contract['session_id'] ?? '' ),
			'authorization'    => is_array( $contract['authorization'] ?? null ) ? self::compact_browser_dto_value( $contract['authorization'] ) : array(),
			'task_input'       => is_array( $contract['task_input'] ?? null ) ? self::compact_browser_dto_value( $contract['task_input'] ) : array(),
			'task_payload'     => is_array( $contract['task_payload'] ?? null ) ? self::compact_browser_dto_value( $contract['task_payload'] ) : array(),
			'materialization'  => is_array( $contract['materialization'] ?? null ) ? self::compact_browser_dto_value( $contract['materialization'] ) : array(),
			'recipe'           => is_array( $contract['recipe'] ?? null ) ? self::compact_browser_recipe_dto( $contract['recipe'] ) : array(),
			'playground'       => is_array( $contract['playground'] ?? null ) ? self::compact_browser_playground_dto( $contract['playground'] ) : array(),
			'artifacts'        => is_array( $contract['artifacts'] ?? null ) ? self::compact_browser_dto_value( $contract['artifacts'] ) : array(),
			'provenance'       => is_array( $contract['provenance'] ?? null ) ? self::compact_browser_dto_value( $contract['provenance'] ) : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $session Browser session envelope. @return array<string,mixed> */
private static function compact_browser_session_dto( array $session ): array {
	return array_filter(
		array(
			'success'          => (bool) ( $session['success'] ?? false ),
			'schema'           => (string) ( $session['schema'] ?? 'wp-codebox/browser-playground-session/v1' ),
			'dto_schema'       => 'wp-codebox/browser-session-product-dto/v1',
			'execution'        => (string) ( $session['execution'] ?? '' ),
			'execution_scope'  => (string) ( $session['execution_scope'] ?? '' ),
			'permission_model' => (string) ( $session['permission_model'] ?? '' ),
			'status'           => (string) ( $session['status'] ?? '' ),
			'error'            => is_array( $session['error'] ?? null ) ? self::compact_browser_dto_value( $session['error'] ) : array(),
			'session'          => is_array( $session['session'] ?? null ) ? self::compact_browser_dto_value( $session['session'] ) : array(),
			'task'             => (string) ( $session['task'] ?? '' ),
			'task_input'       => is_array( $session['task_input'] ?? null ) ? self::compact_browser_dto_value( $session['task_input'] ) : array(),
			'task_payload'     => is_array( $session['task_payload'] ?? null ) ? self::compact_browser_dto_value( $session['task_payload'] ) : array(),
			'agent'            => (string) ( $session['agent'] ?? '' ),
			'provider'         => (string) ( $session['provider'] ?? '' ),
			'model'            => (string) ( $session['model'] ?? '' ),
			'inheritance'      => is_array( $session['inheritance'] ?? null ) ? self::compact_browser_dto_value( $session['inheritance'] ) : array(),
			'materialization'  => is_array( $session['materialization'] ?? null ) ? self::compact_browser_dto_value( $session['materialization'] ) : array(),
			'playground'       => is_array( $session['playground'] ?? null ) ? self::compact_browser_playground_dto( $session['playground'] ) : array(),
			'recipe'           => is_array( $session['recipe'] ?? null ) ? self::compact_browser_recipe_dto( $session['recipe'] ) : array(),
			'signals'          => is_array( $session['signals'] ?? null ) ? self::compact_browser_dto_value( $session['signals'] ) : array(),
			'artifacts'        => is_array( $session['artifacts'] ?? null ) ? self::compact_browser_dto_value( $session['artifacts'] ) : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $playground Playground contract. @return array<string,mixed> */
private static function compact_browser_playground_dto( array $playground ): array {
	return array_filter(
		array(
			'client_module_url'  => (string) ( $playground['client_module_url'] ?? '' ),
			'remote_url'         => (string) ( $playground['remote_url'] ?? '' ),
			'cors_proxy_url'     => (string) ( $playground['cors_proxy_url'] ?? '' ),
			'scope'              => (string) ( $playground['scope'] ?? '' ),
			'artifact_base_path' => (string) ( $playground['artifact_base_path'] ?? '' ),
			'artifact_base_url'  => (string) ( $playground['artifact_base_url'] ?? '' ),
			'preview_url'        => (string) ( $playground['preview_url'] ?? '' ),
			'capabilities'       => is_array( $playground['capabilities'] ?? null ) ? self::compact_browser_dto_value( $playground['capabilities'] ) : array(),
			'provenance'         => is_array( $playground['provenance'] ?? null ) ? self::compact_browser_dto_value( $playground['provenance'] ) : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $recipe Browser recipe. @return array<string,mixed> */
private static function compact_browser_recipe_dto( array $recipe ): array {
	$compact = self::compact_browser_dto_value( $recipe );
	if ( is_array( $compact ) && isset( $compact['runtime'] ) && is_array( $compact['runtime'] ) ) {
		unset( $compact['runtime']['blueprint'] );
	}

	return is_array( $compact ) ? $compact : array();
}

private static function compact_browser_dto_value( mixed $value, string $key = '' ): mixed {
	$key = (string) $key;
	if ( self::compact_browser_dto_key_should_omit( $key ) ) {
		return null;
	}
	if ( self::compact_browser_dto_key_should_redact( $key ) ) {
		return '[redacted]';
	}
	if ( ! is_array( $value ) ) {
		return $value;
	}

	$compact = array();
	foreach ( $value as $child_key => $child_value ) {
		$child_compact = self::compact_browser_dto_value( $child_value, is_string( $child_key ) ? $child_key : '' );
		if ( null === $child_compact ) {
			continue;
		}

		$compact[ $child_key ] = $child_compact;
	}

	return $compact;
}

private static function compact_browser_dto_key_should_omit( string $key ): bool {
	return in_array( $key, array( 'pluginData', 'source', 'content', 'content_base64', 'bundle', 'plugins', 'runtime' ), true );
}

private static function compact_browser_dto_key_should_redact( string $key ): bool {
	$normalized = strtolower( $key );
	if ( in_array( $normalized, array( 'secret_env', 'secretenv', 'secret_env_names' ), true ) ) {
		return false;
	}

	foreach ( array( 'secret', 'token', 'password', 'private_key', 'api_key', 'credential' ) as $needle ) {
		if ( str_contains( $normalized, $needle ) ) {
			return true;
		}
	}

	return false;
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $session_envelope Primary browser session envelope. @return array<int,array<string,mixed>>|WP_Error */
private static function browser_task_contract_phases( array $input, array $session_envelope ): array|WP_Error {
	$phase_specs = is_array( $input['phases'] ?? null ) ? $input['phases'] : array();
	if ( empty( $phase_specs ) && is_array( $input['materializers'] ?? null ) ) {
		$phase_specs = array_map(
			static fn( mixed $materializer ): array => array(
				'kind'  => 'materializer',
				'input' => is_array( $materializer ) ? $materializer : array(),
			),
			$input['materializers']
		);
	}

	$phases = array();
	foreach ( $phase_specs as $index => $phase ) {
		if ( ! is_array( $phase ) ) {
			return new WP_Error( 'wp_codebox_browser_phase_invalid', 'Each browser task phase must be an object.', array( 'status' => 400, 'index' => $index ) );
		}

		$kind = self::safe_key( (string) ( $phase['kind'] ?? 'materializer' ) );
		if ( 'materializer' !== $kind ) {
			return new WP_Error( 'wp_codebox_browser_phase_kind_invalid', 'Browser task phases currently support materializer phases only.', array( 'status' => 400, 'index' => $index, 'kind' => $kind ) );
		}

		$phase_input = is_array( $phase['input'] ?? null ) ? $phase['input'] : array();
		$phase_input = array_replace_recursive( $input, $phase_input );
		unset( $phase_input['phases'], $phase_input['materializers'] );

		if ( empty( $phase_input['sandbox_session_id'] ) && '' !== (string) ( $session_envelope['id'] ?? '' ) ) {
			$phase_input['sandbox_session_id'] = (string) $session_envelope['id'];
		}

		$contract = self::create_browser_materializer_contract( $phase_input );
		if ( is_wp_error( $contract ) ) {
			return $contract;
		}

		$phases[] = array(
			'name'     => self::safe_key( (string) ( $phase['name'] ?? $kind . '-' . ( $index + 1 ) ) ),
			'kind'     => $kind,
			'index'    => $index,
			'contract' => $contract,
		);
	}

	return $phases;
}

/**
 * @param array<string,mixed> $input Ability input.
 * @param array<string,mixed> $task_input Normalized task input.
 * @param array<string,mixed> $ready_to_code Readiness signal.
 * @param array<int,array<string,string>> $browser_plugins Browser plugin specs.
 * @param array<string,mixed> $runtime Normalized runtime dependency specs.
 * @param array<int,array<string,string>> $artifacts Browser artifact specs.
 * @param array<string,mixed> $playground Playground input.
 * @param array<string,mixed> $blueprint Playground blueprint.
 * @param array<string,mixed> $site_blueprint_artifact Normalized site blueprint artifact.
 * @return array<string,mixed>
 */
private static function blocked_browser_playground_session( string $session_id, array $input, array $task_input, array $ready_to_code, array $browser_plugins, array $runtime, array $artifacts, array $playground, array $blueprint, array $site_blueprint_artifact ): array {
	return array(
		'success'          => false,
		'schema'           => 'wp-codebox/browser-playground-session/v1',
		'execution'        => 'browser-playground',
		'execution_scope'  => 'disposable-playground',
		'permission_model' => 'runtime-principal',
		'status'           => 'blocked',
		'error'            => array(
			'code'    => 'wp_codebox_browser_prerequisites_missing',
			'message' => 'Browser Playground sandbox is missing required coding prerequisites.',
			'missing' => $ready_to_code['missing'] ?? array(),
		),
		'session'          => self::browser_session_envelope( $session_id, 'blocked', $input ),
		'task'             => (string) $task_input['goal'],
		'task_input' => $task_input,
		'agent'      => (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
		'plugins'    => $browser_plugins,
		'runtime'    => $runtime,
		'site_blueprint_artifact' => $site_blueprint_artifact,
		'materialization' => array(
			'schema' => 'wp-codebox/browser-materialization/v1',
			'status' => 'blocked',
			'captures' => array(),
		),
		'playground' => array(
			'client_module_url'  => $playground['client_module_url'],
			'remote_url'         => $playground['remote_url'],
			'cors_proxy_url'     => $playground['cors_proxy_url'],
			'scope'              => (string) ( $playground['scope'] ?? $session_id ),
			'artifact_base_path' => self::browser_artifact_base_path( $playground ),
			'artifact_base_url'  => self::browser_artifact_base_url( $playground ),
			'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
			'blueprint'          => self::browser_playground_blueprint( $blueprint, $playground ),
			'capabilities'       => array(
				'compile_blueprint' => true,
				'run_blueprint'     => true,
				'write_file'        => true,
				'run_php'           => true,
			),
			'provenance'         => $playground['provenance'],
		),
		'signals'    => array(
			'ready_to_code' => $ready_to_code,
		),
		'artifacts'  => array(
			'schema'             => 'wp-codebox/browser-artifacts/v1',
			'files'              => $artifacts,
			'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
			'expected_artifacts' => $task_input['expected_artifacts'],
		),
	);
}

/** @return array<string,mixed> */
private static function browser_session_envelope( string $session_id, string $status, array $input ): array {
	$session = WP_Codebox_Agent_Task::session( $session_id, $status, $input );
	$session['execution_scope']  = 'disposable-playground';
	$session['permission_model'] = 'runtime-principal';
	$authorization               = self::browser_session_authorization( $input );
	if ( ! empty( $authorization['caller'] ) || ! empty( $authorization['scope'] ) ) {
		$session['authorization'] = $authorization;
	}

	return $session;
}

/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $runtime Normalized runtime dependency specs. @return array<string,mixed> */
private static function browser_ready_to_code_signal( array $input, array $runtime ): array {
	$provider_plugin_paths = array_values(
		array_filter(
			array_map( 'strval', is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : array() ),
			static fn( string $path ): bool => '' !== trim( $path )
		)
	);
	$inherit      = is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array();
	$connectors   = array_values( array_filter( array_map( 'strval', is_array( $inherit['connectors'] ?? null ) ? $inherit['connectors'] : array() ) ) );
	$secret_env   = array_values( array_filter( array_map( 'strval', is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array() ) ) );
	$requirements = array(
		'agents_api'        => self::agents_api_ready() && self::browser_runtime_has_plugin( $runtime, 'agents-api' ),
		'data_machine'      => self::browser_runtime_has_plugin( $runtime, 'data-machine' ),
		'data_machine_code' => self::browser_runtime_has_plugin( $runtime, 'data-machine-code' ),
		'provider_plugin'   => ! empty( $provider_plugin_paths ) && self::all_paths_ready( $provider_plugin_paths ),
		'provider_secret'   => ! empty( $connectors ) || ! empty( $secret_env ),
		'runtime_dependencies' => true,
	);

	/**
	 * Filters browser sandbox readiness requirements before the signal is emitted.
	 *
	 * @param array<string,bool>  $requirements Named readiness checks.
	 * @param array<string,mixed> $input        Ability input.
	 */
	$requirements = apply_filters( 'wp_codebox_browser_ready_to_code_requirements', $requirements, $input );
	$requirements = is_array( $requirements ) ? array_map( 'boolval', $requirements ) : array();
	$missing      = array_keys( array_filter( $requirements, static fn( bool $ready ): bool => ! $ready ) );
	$emitted      = empty( $missing );

	return array(
		'schema'       => 'wp-codebox/signal/v1',
		'name'         => 'ready_to_code',
		'emitted'      => $emitted,
		'message'      => $emitted ? 'Browser Playground sandbox is ready to code.' : 'Browser Playground sandbox is not ready to code.',
		'requirements' => $requirements,
		'requirement_metadata' => array(
			'runtime_dependencies' => self::browser_runtime_readiness_metadata( $runtime ),
		),
		'missing'      => $missing,
	);
}

private static function agents_api_ready(): bool {
	if ( ! function_exists( 'wp_get_ability' ) ) {
		return false;
	}

	return (bool) wp_get_ability( 'agents/chat' );
}

/** @param array<int,string> $paths Paths to verify. */
private static function all_paths_ready( array $paths ): bool {
	foreach ( $paths as $path ) {
		if ( ! is_dir( $path ) ) {
			return false;
		}
	}

	return true;
}

/** @param array<string,mixed> $runtime Normalized runtime dependencies. */
private static function browser_runtime_has_plugin( array $runtime, string $slug ): bool {
	foreach ( is_array( $runtime['plugins'] ?? null ) ? $runtime['plugins'] : array() as $plugin ) {
		if ( is_array( $plugin ) && $slug === self::safe_key( (string) ( $plugin['slug'] ?? '' ) ) ) {
			return true;
		}
	}

	return false;
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function list_artifacts( array $input = array() ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->list( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function get_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->get( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function discard_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->discard( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function normalize_browser_artifact_bundle( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->normalize_browser_bundle( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function persist_browser_artifact( array $input ): array|WP_Error {
	$result = ( new WP_Codebox_Artifacts() )->persist_browser_bundle( $input );
	if ( is_wp_error( $result ) ) {
		return $result;
	}

	$authorization = self::trusted_orchestrator_authorization( $input, self::BROWSER_ARTIFACT_WRITE_SCOPE );
	if ( ! empty( $authorization['caller'] ) || ! empty( $authorization['scope'] ) ) {
		$result['authorization'] = $authorization;
	}

	return $result;
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function review_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->review_artifact( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function apply_artifact_preflight( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->apply_preflight( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function apply_approved_artifact( array $input ): array|WP_Error {
	return ( new WP_Codebox_Artifacts() )->apply_approved( $input );
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
public static function stage_artifact_apply( array $input ): array|WP_Error {
	return WP_Codebox_Data_Machine_Pending_Actions::stage_apply_artifact( $input );
}
}
