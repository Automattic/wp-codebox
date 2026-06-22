<?php
/**
 * WP Codebox WordPress workload runner.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Safe executor for public recipe-backed WordPress workload requests.
 */
final class WP_Codebox_WordPress_Workload_Runner {

	/** @param array<string,mixed> $input Workload request. @return array<string,mixed>|WP_Error */
	public function run( array $input ): array|WP_Error {
		$steps = $this->all_steps( $input );
		if ( empty( $steps ) ) {
			return new WP_Error( 'wp_codebox_wordpress_workload_steps_missing', 'WordPress workload requests require at least one declarative step.', array( 'status' => 400 ) );
		}

		foreach ( $this->providers( $input ) as $provider ) {
			if ( ! $this->provider_matches( $provider, $input ) ) {
				continue;
			}

			$result = $this->execute_provider( $provider, $input );
			if ( is_wp_error( $result ) ) {
				return $result;
			}

			return $this->result_envelope( $input, $result, $this->provider_id( $provider ) );
		}

		return new WP_Error( 'wp_codebox_wordpress_workload_runner_unavailable', 'WordPress workload execution is unavailable.', array( 'status' => 501 ) );
	}

	/** @param array<string,mixed> $input Workload request. @return array<int,array<string,mixed>> */
	private function providers( array $input ): array {
		$providers = array(
			array(
				'id'       => 'wp-codebox-safe-wordpress-workload-runner',
				'callback' => fn( array $request ): array|WP_Error => $this->execute_recipe( $request ),
			),
		);

		if ( function_exists( 'apply_filters' ) ) {
			$providers = apply_filters( 'wp_codebox_wordpress_workload_runners', $providers, $input );
		}

		return is_array( $providers ) ? array_values( array_filter( $providers, 'is_array' ) ) : array();
	}

	/** @param array<string,mixed> $provider Workload provider. @param array<string,mixed> $input Workload request. */
	private function provider_matches( array $provider, array $input ): bool {
		$matches = $provider['matches'] ?? null;
		return is_callable( $matches ) ? true === $matches( $input ) : true;
	}

	/** @param array<string,mixed> $provider Workload provider. @param array<string,mixed> $input Workload request. @return array<string,mixed>|WP_Error */
	private function execute_provider( array $provider, array $input ): array|WP_Error {
		$callback = $provider['callback'] ?? null;
		if ( ! is_callable( $callback ) ) {
			return new WP_Error( 'wp_codebox_wordpress_workload_provider_invalid', 'WordPress workload provider is invalid.', array( 'status' => 500 ) );
		}

		$result = $callback( $input, $provider );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return is_array( $result ) ? $result : new WP_Error( 'wp_codebox_wordpress_workload_provider_invalid_result', 'WordPress workload provider returned an invalid result.', array( 'status' => 502 ) );
	}

	/** @param array<string,mixed> $provider Workload provider. */
	private function provider_id( array $provider ): string {
		$id = trim( (string) ( $provider['id'] ?? '' ) );
		return '' === $id ? 'wordpress-workload-provider' : $id;
	}

	/** @param array<string,mixed> $input Workload request. @return array<string,mixed> */
	private function execute_recipe( array $input ): array {
		$steps       = array();
		$diagnostics = array();
		$artifacts   = array();

		foreach ( $this->all_steps( $input ) as $index => $step ) {
			$result = $this->execute_step( $step, $input, $index );
			$steps[] = $result;

			foreach ( is_array( $result['diagnostics'] ?? null ) ? $result['diagnostics'] : array() as $diagnostic ) {
				$diagnostics[] = $diagnostic;
			}
			foreach ( is_array( $result['artifactRefs'] ?? null ) ? $result['artifactRefs'] : array() as $artifact ) {
				$artifacts[] = $artifact;
			}
		}

		return array(
			'steps'       => $steps,
			'diagnostics' => $diagnostics,
			'artifacts'   => $this->dedupe_artifacts( $artifacts ),
			'recipe'      => $this->recipe_summary( $input ),
		);
	}

	/** @param array<string,mixed> $input Workload request. @return array<int,array<string,mixed>> */
	private function all_steps( array $input ): array {
		$steps = array();
		foreach ( array( 'before', 'steps', 'after' ) as $phase ) {
			foreach ( is_array( $input[ $phase ] ?? null ) ? $input[ $phase ] : array() as $step ) {
				if ( is_array( $step ) ) {
					$step['phase'] = $step['phase'] ?? $phase;
					$steps[]       = $step;
				}
			}
		}

		return $steps;
	}

	/** @param array<string,mixed> $step Workload step. @param array<string,mixed> $input Workload request. @return array<string,mixed> */
	private function execute_step( array $step, array $input, int $index ): array {
		$command = trim( (string) ( $step['command'] ?? '' ) );
		$args    = $this->parse_args( is_array( $step['args'] ?? null ) ? $step['args'] : array() );

		try {
			$result = match ( $command ) {
				'wordpress.rest-request'             => $this->execute_rest_request( $args, $index ),
				'wordpress.collect-workload-result'  => $this->collect_artifact( $args, $input ),
				'wordpress.run-workload', 'wordpress.run-declarative-fuzz' => $this->acknowledge_recipe_step( $command ),
				default                              => $this->unsupported_step( $command, $index ),
			};
		} catch ( Throwable $throwable ) {
			$result = array(
				'status'      => 'error',
				'diagnostics' => array( $this->diagnostic( 'error', 'wp_codebox_wordpress_workload_step_exception', $throwable->getMessage(), array( 'step_index' => $index, 'command' => $command ) ) ),
			);
		}

		$status = (string) ( $result['status'] ?? 'error' );
		if ( in_array( $status, array( 'failed', 'error' ), true ) && ( true === ( $step['allowFailure'] ?? false ) || true === ( $step['advisory'] ?? false ) ) ) {
			$status = 'skipped';
		}

		return array_filter(
			array(
				'index'        => $index,
				'phase'        => (string) ( $step['phase'] ?? '' ),
				'command'      => $command,
				'success'      => 'passed' === $status,
				'status'       => $status,
				'observation'  => is_array( $result['observation'] ?? null ) ? $result['observation'] : array(),
				'diagnostics'  => is_array( $result['diagnostics'] ?? null ) ? $result['diagnostics'] : array(),
				'artifactRefs' => is_array( $result['artifactRefs'] ?? null ) ? $result['artifactRefs'] : array(),
			),
			static fn( mixed $value ): bool => ! ( is_array( $value ) && empty( $value ) ) && '' !== $value
		);
	}

	/** @param array<string,string> $args Step args. @return array<string,mixed> */
	private function execute_rest_request( array $args, int $index ): array {
		$path = (string) ( $args['path'] ?? $args['route'] ?? '' );
		if ( '' === $path || ! str_starts_with( $path, '/' ) ) {
			return array( 'status' => 'error', 'diagnostics' => array( $this->diagnostic( 'error', 'wp_codebox_wordpress_workload_rest_path_invalid', 'REST workload steps require an absolute path.', array( 'step_index' => $index, 'path' => $path ) ) ) );
		}

		$request = new WP_REST_Request( strtoupper( (string) ( $args['method'] ?? 'GET' ) ), $path );
		foreach ( $this->json_arg( $args['params-json'] ?? '' ) as $key => $value ) {
			$request->set_param( (string) $key, $value );
		}
		foreach ( $this->json_arg( $args['headers-json'] ?? '' ) as $key => $value ) {
			$request->set_header( (string) $key, (string) $value );
		}
		if ( isset( $args['body-json'] ) && '' !== $args['body-json'] ) {
			$request->set_body_params( $this->json_arg( $args['body-json'] ) );
		} elseif ( isset( $args['body'] ) ) {
			$request->set_body( $args['body'] );
		}

		$response = rest_do_request( $request );
		$status   = (int) $response->get_status();

		return array(
			'status'      => $status >= 500 ? 'failed' : 'passed',
			'observation' => array( 'path' => $path, 'status' => $status ),
			'diagnostics' => $status >= 500 ? array( $this->diagnostic( 'error', 'wp_codebox_wordpress_workload_rest_request_failed', 'REST workload step returned a server error.', array( 'step_index' => $index, 'status' => $status, 'path' => $path ) ) ) : array(),
		);
	}

	/** @param array<string,string> $args Step args. @param array<string,mixed> $input Workload request. @return array<string,mixed> */
	private function collect_artifact( array $args, array $input ): array {
		$name      = (string) ( $args['artifact'] ?? $args['name'] ?? '' );
		$artifacts = is_array( $input['artifacts'] ?? null ) ? $input['artifacts'] : array();
		$refs      = array_values(
			array_filter(
				$artifacts,
				static fn( mixed $artifact ): bool => is_array( $artifact ) && ( '' === $name || (string) ( $artifact['name'] ?? '' ) === $name )
			)
		);

		return array( 'status' => 'passed', 'observation' => array_filter( array( 'artifact' => $name ) ), 'artifactRefs' => $refs );
	}

	/** @return array<string,mixed> */
	private function acknowledge_recipe_step( string $command ): array {
		return array( 'status' => 'passed', 'observation' => array( 'command' => $command, 'mode' => 'recipe-backed' ) );
	}

	/** @return array<string,mixed> */
	private function unsupported_step( string $command, int $index ): array {
		return array(
			'status'      => 'skipped',
			'observation' => array( 'command' => $command ),
			'diagnostics' => array( $this->diagnostic( 'warning', 'wp_codebox_wordpress_workload_step_unsupported', 'WordPress workload step is not supported by this safe runner.', array( 'step_index' => $index, 'command' => $command ) ) ),
		);
	}

	/** @param string[] $args Step args. @return array<string,string> */
	private function parse_args( array $args ): array {
		$parsed = array();
		foreach ( $args as $arg ) {
			$parts             = explode( '=', (string) $arg, 2 );
			$parsed[ $parts[0] ] = $parts[1] ?? '';
		}

		return $parsed;
	}

	/** @return array<string,mixed> */
	private function json_arg( string $value ): array {
		if ( '' === $value ) {
			return array();
		}
		$decoded = json_decode( $value, true );
		return is_array( $decoded ) ? $decoded : array();
	}

	/** @param array<int,array<string,mixed>> $artifacts Artifact refs. @return array<int,array<string,mixed>> */
	private function dedupe_artifacts( array $artifacts ): array {
		$seen = array();
		$out  = array();
		foreach ( $artifacts as $artifact ) {
			$key = (string) ( $artifact['name'] ?? '' ) . '|' . (string) ( $artifact['path'] ?? '' );
			if ( isset( $seen[ $key ] ) ) {
				continue;
			}
			$seen[ $key ] = true;
			$out[]        = $artifact;
		}

		return $out;
	}

	/** @param array<string,mixed> $input Workload request. @return array<string,mixed> */
	private function recipe_summary( array $input ): array {
		return array_filter(
			array(
				'schema'            => (string) ( $input['schema'] ?? 'wp-codebox/wordpress-workload-run/v1' ),
				'wordpress_version' => (string) ( $input['wordpress_version'] ?? '' ),
				'has_blueprint'     => is_array( $input['blueprint'] ?? null ),
				'step_count'        => count( $this->all_steps( $input ) ),
			),
			static fn( mixed $value ): bool => '' !== $value
		);
	}

	/** @param array<string,mixed> $input Workload request. @param array<string,mixed> $result Provider result. @return array<string,mixed> */
	private function result_envelope( array $input, array $result, string $runner ): array {
		$steps       = is_array( $result['steps'] ?? null ) ? $result['steps'] : array();
		$diagnostics = is_array( $result['diagnostics'] ?? null ) ? $result['diagnostics'] : array();
		$status      = $this->overall_status( $steps );

		return array(
			'success'     => 'completed' === $status,
			'schema'      => 'wp-codebox/wordpress-workload-run-result/v1',
			'status'      => $status,
			'request'     => array( 'schema' => (string) ( $input['schema'] ?? 'wp-codebox/wordpress-workload-run/v1' ) ),
			'steps'       => $steps,
			'artifacts'   => is_array( $result['artifacts'] ?? null ) ? $result['artifacts'] : array(),
			'diagnostics' => $diagnostics,
			'metadata'    => array_filter(
				array(
					'canonical_ability' => 'wp-codebox/run-wordpress-workload',
					'runner'            => $runner,
					'recipe'            => is_array( $result['recipe'] ?? null ) ? $result['recipe'] : array(),
					'input'             => is_array( $input['metadata'] ?? null ) ? $input['metadata'] : array(),
				),
				static fn( mixed $value ): bool => ! ( is_array( $value ) && empty( $value ) )
			),
		);
	}

	/** @param array<int,array<string,mixed>> $steps Step results. */
	private function overall_status( array $steps ): string {
		$passed = 0;
		foreach ( $steps as $step ) {
			$status = (string) ( $step['status'] ?? '' );
			if ( in_array( $status, array( 'failed', 'error' ), true ) ) {
				return 'failed';
			}
			if ( 'passed' === $status ) {
				++$passed;
			}
		}

		return $passed > 0 ? 'completed' : 'skipped';
	}

	/** @return array<string,mixed> */
	private function diagnostic( string $severity, string $code, string $message, array $metadata = array() ): array {
		return array_filter( array( 'severity' => $severity, 'code' => $code, 'message' => $message, 'metadata' => $metadata ), static fn( mixed $value ): bool => ! ( is_array( $value ) && empty( $value ) ) );
	}
}
