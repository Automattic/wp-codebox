<?php
/**
 * Shared fanout aggregation contract helpers for PHP host fanout.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Fanout_Aggregation {

	public const INPUT_SCHEMA  = 'wp-codebox/agent-fanout-aggregation-input/v1';
	public const OUTPUT_SCHEMA = 'wp-codebox/agent-fanout-aggregation-output/v1';

	/** @param array<string,mixed> $options Aggregation input options. @return array<string,mixed> */
	public function input_from_worker_artifacts( array $options ): array {
		return $this->normalize_input(
			array(
				'plan'               => $options['plan'] ?? array(),
				'policy'             => $options['policy'] ?? 'fail',
				'aggregator'         => $options['aggregator'] ?? null,
				'workerResultRefs'   => $options['workerResultRefs'] ?? array(),
				'artifactRefs'       => $options['workerArtifacts'] ?? array(),
				'conflictCandidates' => $options['conflictCandidates'] ?? array(),
				'metadata'           => $options['metadata'] ?? null,
			)
		);
	}

	/** @param array<string,mixed> $input Aggregation input. @return array<string,mixed> */
	public function aggregate( array $input, array $options = array() ): array {
		$normalized = $this->normalize_input( $input );
		$conflicts  = array_merge(
			$this->normalize_conflict_records( $normalized['conflictCandidates'] ?? array() ),
			$this->duplicate_final_artifact_path_conflicts( $normalized['artifactRefs'] ?? array() ),
			$this->worker_dependency_conflicts( $normalized['plan'] ?? array(), $normalized['workerResultRefs'] ?? array() )
		);

		if ( is_array( $options['aggregationError'] ?? null ) ) {
			$error       = $options['aggregationError'];
			$conflicts[] = array_filter(
				array(
					'type'     => 'aggregation-failure',
					'severity' => 'error',
					'message'  => (string) ( $error['message'] ?? 'Fanout aggregation failed.' ),
					'details'  => array_filter(
						array_merge(
							array( 'code' => $error['code'] ?? null ),
							is_array( $error['details'] ?? null ) ? $error['details'] : array()
						),
						static fn( mixed $value ): bool => null !== $value && '' !== $value
					),
				),
				static fn( mixed $value ): bool => array() !== $value
			);
		}

		$has_error = ! empty( array_filter( $conflicts, static fn( array $conflict ): bool => 'error' === (string) ( $conflict['severity'] ?? '' ) ) );

		return array_filter(
			array(
				'schema'                => self::OUTPUT_SCHEMA,
				'status'                => $this->resolve_status( (string) $normalized['policy'], $conflicts ),
				'policy'                => (string) $normalized['policy'],
				'plan'                  => $normalized['plan'],
				'aggregator'            => $normalized['aggregator'] ?? null,
				'workerResultRefs'      => $normalized['workerResultRefs'],
				'rawWorkerArtifactRefs' => $normalized['artifactRefs'],
				'finalArtifactRefs'     => $has_error ? array() : ( $options['finalArtifactRefs'] ?? $this->default_final_artifact_refs( $normalized, $options['outputNamespace'] ?? null ) ),
				'conflicts'             => $conflicts,
				'metadata'              => $options['metadata'] ?? $normalized['metadata'] ?? null,
			),
			static fn( mixed $value ): bool => null !== $value
		);
	}

	/** @param array<string,mixed> $input Aggregation input. @return array<string,mixed> */
	public function normalize_input( array $input ): array {
		$worker_results      = $this->normalize_worker_result_refs( $input['workerResultRefs'] ?? array() );
		$input_artifact_refs = $this->normalize_artifact_refs( $input['artifactRefs'] ?? array() );
		$artifact_refs       = self::INPUT_SCHEMA === (string) ( $input['schema'] ?? '' ) ? $input_artifact_refs : array_merge( $input_artifact_refs, ...array_map( static fn( array $worker ): array => $worker['artifactRefs'] ?? array(), $worker_results ) );

		return array_filter(
			array(
				'schema'             => self::INPUT_SCHEMA,
				'plan'               => $this->normalize_plan( is_array( $input['plan'] ?? null ) ? $input['plan'] : array() ),
				'policy'             => (string) ( $input['policy'] ?? 'fail' ),
				'aggregator'         => is_array( $input['aggregator'] ?? null ) ? $input['aggregator'] : null,
				'workerResultRefs'   => $worker_results,
				'artifactRefs'       => $artifact_refs,
				'conflictCandidates' => $this->normalize_conflict_records( $input['conflictCandidates'] ?? array() ),
				'metadata'           => is_array( $input['metadata'] ?? null ) ? $input['metadata'] : null,
			),
			static fn( mixed $value ): bool => null !== $value
		);
	}

	/** @param array<string,mixed> $input Aggregation input. @return array<int,array<string,mixed>> */
	public function default_final_artifact_refs( array $input, mixed $output_namespace = null ): array {
		return array(
			array(
				'path'        => $this->default_output_path( $input, $output_namespace ),
				'kind'        => 'fanout-aggregate-output',
				'contentType' => 'application/json',
			),
		);
	}

	/** @param array<string,mixed> $input Aggregation input. */
	public function default_output_path( array $input, mixed $output_namespace = null ): string {
		$normalized = $this->normalize_input( $input );
		$aggregator = is_array( $normalized['aggregator'] ?? null ) ? $normalized['aggregator'] : array();
		return $this->normalize_output_namespace( $output_namespace ?? $aggregator['outputNamespace'] ?? null ) . '/result.json';
	}

	/** @param array<int,array<string,mixed>> $conflicts Conflicts. */
	private function resolve_status( string $policy, array $conflicts ): string {
		$has_error = ! empty( array_filter( $conflicts, static fn( array $conflict ): bool => 'error' === (string) ( $conflict['severity'] ?? '' ) ) );
		if ( ! $has_error ) {
			return 'succeeded';
		}
		if ( 'partial' === $policy ) {
			return 'partial';
		}
		if ( 'repair' === $policy ) {
			return 'repair_required';
		}
		if ( 'caller-review-required' === $policy ) {
			return 'caller_review_required';
		}
		return 'failed';
	}

	/** @param array<string,mixed> $plan Plan. @return array<string,mixed> */
	private function normalize_plan( array $plan ): array {
		$workers = is_array( $plan['workers'] ?? null ) ? array_map( fn( mixed $worker ): array => $this->normalize_worker_plan( is_array( $worker ) ? $worker : array() ), $plan['workers'] ) : array();
		$plan['id'] = is_string( $plan['id'] ?? null ) && '' !== $plan['id'] ? $plan['id'] : null;
		$plan['workers'] = $workers;
		$plan['metadata'] = is_array( $plan['metadata'] ?? null ) ? $plan['metadata'] : null;

		return array_filter( $plan, static fn( mixed $value ): bool => null !== $value );
	}

	/** @param array<string,mixed> $worker Worker plan. @return array<string,mixed> */
	private function normalize_worker_plan( array $worker ): array {
		$worker['id'] = is_string( $worker['id'] ?? null ) ? $worker['id'] : '';
		$worker['dependsOn'] = is_array( $worker['dependsOn'] ?? null ) ? array_values( array_filter( $worker['dependsOn'], 'is_string' ) ) : array();
		$worker['required'] = false !== ( $worker['required'] ?? true );
		$worker['artifactNamespace'] = is_string( $worker['artifactNamespace'] ?? null ) ? $worker['artifactNamespace'] : null;
		$worker['metadata'] = is_array( $worker['metadata'] ?? null ) ? $worker['metadata'] : null;

		return array_filter( $worker, static fn( mixed $value ): bool => null !== $value );
	}

	/** @param mixed $worker_results Worker results. @return array<int,array<string,mixed>> */
	private function normalize_worker_result_refs( mixed $worker_results ): array {
		if ( ! is_array( $worker_results ) ) {
			return array();
		}

		return array_map( fn( mixed $worker ): array => $this->normalize_worker_result_ref( is_array( $worker ) ? $worker : array() ), $worker_results );
	}

	/** @param array<string,mixed> $worker Worker result. @return array<string,mixed> */
	private function normalize_worker_result_ref( array $worker ): array {
		$worker_id = is_string( $worker['workerId'] ?? null ) && '' !== $worker['workerId'] ? $worker['workerId'] : '';

		return array_filter(
			array(
				'workerId'     => $worker_id,
				'status'       => WP_Codebox_Status_Taxonomy::agent_task_status( array( 'status' => $worker['status'] ?? '', 'success' => $worker['success'] ?? null ) ),
				'required'     => false !== ( $worker['required'] ?? true ),
				'resultRef'    => is_string( $worker['resultRef'] ?? null ) ? $worker['resultRef'] : null,
				'artifactRefs' => $this->normalize_artifact_refs( $worker['artifactRefs'] ?? array(), $worker_id ),
				'error'        => $this->normalize_error( $worker['error'] ?? null ),
				'metadata'     => is_array( $worker['metadata'] ?? null ) ? $worker['metadata'] : null,
			),
			static fn( mixed $value ): bool => null !== $value
		);
	}

	/** @param mixed $artifacts Artifact refs. @return array<int,array<string,mixed>> */
	private function normalize_artifact_refs( mixed $artifacts, mixed $fallback_worker_id = null ): array {
		if ( ! is_array( $artifacts ) ) {
			return array();
		}

		return array_map( fn( mixed $artifact ): array => $this->normalize_artifact_ref( is_array( $artifact ) ? $artifact : array(), $fallback_worker_id ), $artifacts );
	}

	/** @param array<string,mixed> $artifact Artifact ref. @return array<string,mixed> */
	private function normalize_artifact_ref( array $artifact, mixed $fallback_worker_id = null ): array {
		return array_filter(
			array(
				'id'          => is_string( $artifact['id'] ?? null ) ? $artifact['id'] : null,
				'path'        => is_string( $artifact['path'] ?? null ) ? $artifact['path'] : '',
				'kind'        => is_string( $artifact['kind'] ?? null ) ? $artifact['kind'] : null,
				'workerId'    => is_string( $artifact['workerId'] ?? null ) ? $artifact['workerId'] : ( is_string( $fallback_worker_id ) ? $fallback_worker_id : null ),
				'namespace'   => is_string( $artifact['namespace'] ?? null ) ? $artifact['namespace'] : null,
				'finalPath'   => is_string( $artifact['finalPath'] ?? null ) ? $artifact['finalPath'] : null,
				'contentType' => is_string( $artifact['contentType'] ?? null ) ? $artifact['contentType'] : null,
				'sha256'      => is_string( $artifact['sha256'] ?? null ) ? $artifact['sha256'] : null,
				'bytes'       => is_int( $artifact['bytes'] ?? null ) || is_float( $artifact['bytes'] ?? null ) ? $artifact['bytes'] : null,
				'metadata'    => is_array( $artifact['metadata'] ?? null ) ? $artifact['metadata'] : null,
			),
			static fn( mixed $value ): bool => null !== $value
		);
	}

	/** @param mixed $conflicts Conflict records. @return array<int,array<string,mixed>> */
	private function normalize_conflict_records( mixed $conflicts ): array {
		if ( ! is_array( $conflicts ) ) {
			return array();
		}

		return array_map( fn( mixed $conflict ): array => $this->normalize_conflict_record( is_array( $conflict ) ? $conflict : array() ), $conflicts );
	}

	/** @param array<string,mixed> $conflict Conflict record. @return array<string,mixed> */
	private function normalize_conflict_record( array $conflict ): array {
		return array_filter(
			array(
				'type'         => is_string( $conflict['type'] ?? null ) ? $conflict['type'] : 'partial-output',
				'severity'     => is_string( $conflict['severity'] ?? null ) ? $conflict['severity'] : 'error',
				'message'      => is_string( $conflict['message'] ?? null ) ? $conflict['message'] : 'Fanout aggregation conflict candidate.',
				'workerIds'    => is_array( $conflict['workerIds'] ?? null ) ? array_values( array_filter( $conflict['workerIds'], 'is_string' ) ) : null,
				'path'         => is_string( $conflict['path'] ?? null ) ? $conflict['path'] : null,
				'artifactRefs' => is_array( $conflict['artifactRefs'] ?? null ) ? $this->normalize_artifact_refs( $conflict['artifactRefs'] ) : null,
				'dependencyId' => is_string( $conflict['dependencyId'] ?? null ) ? $conflict['dependencyId'] : null,
				'details'      => is_array( $conflict['details'] ?? null ) ? $conflict['details'] : null,
			),
			static fn( mixed $value ): bool => null !== $value
		);
	}

	/** @param array<int,array<string,mixed>> $artifact_refs Artifact refs. @return array<int,array<string,mixed>> */
	private function duplicate_final_artifact_path_conflicts( array $artifact_refs ): array {
		$by_path = array();
		foreach ( $artifact_refs as $artifact ) {
			$final_path = (string) ( $artifact['finalPath'] ?? '' );
			if ( '' === $final_path ) {
				continue;
			}
			$by_path[ $final_path ][] = $artifact;
		}

		$conflicts = array();
		foreach ( $by_path as $path => $refs ) {
			if ( count( $refs ) < 2 ) {
				continue;
			}
			$conflicts[] = array(
				'type'         => 'duplicate-final-artifact-path',
				'severity'     => 'error',
				'message'      => 'Multiple fanout worker artifacts target final path ' . $path . '.',
				'path'         => $path,
				'workerIds'    => array_values( array_unique( array_filter( array_map( static fn( array $ref ): string => (string) ( $ref['workerId'] ?? '' ), $refs ) ) ) ),
				'artifactRefs' => $refs,
			);
		}

		return $conflicts;
	}

	/** @param array<string,mixed> $plan Plan. @param array<int,array<string,mixed>> $worker_results Worker results. @return array<int,array<string,mixed>> */
	private function worker_dependency_conflicts( array $plan, array $worker_results ): array {
		$conflicts = array();
		$by_worker = array();
		foreach ( $worker_results as $result ) {
			$by_worker[ (string) ( $result['workerId'] ?? '' ) ] = $result;
			if ( false !== ( $result['required'] ?? true ) && 'succeeded' !== (string) ( $result['status'] ?? '' ) ) {
				$conflicts[] = array_filter(
					array(
						'type'         => 'failed-worker',
						'severity'     => 'error',
						'message'      => 'Required fanout worker ' . (string) ( $result['workerId'] ?? '' ) . ' ended with status ' . (string) ( $result['status'] ?? '' ) . '.',
						'workerIds'    => array( (string) ( $result['workerId'] ?? '' ) ),
						'artifactRefs' => $result['artifactRefs'] ?? array(),
						'details'      => is_array( $result['error'] ?? null ) ? array( 'error' => $result['error'] ) : null,
					),
					static fn( mixed $value ): bool => null !== $value
				);
			}
		}

		foreach ( $plan['workers'] ?? array() as $worker ) {
			foreach ( $worker['dependsOn'] ?? array() as $dependency_id ) {
				if ( ! isset( $by_worker[ $dependency_id ] ) ) {
					$conflicts[] = array(
						'type'         => 'missing-worker-dependency',
						'severity'     => 'error',
						'message'      => 'Fanout worker ' . (string) ( $worker['id'] ?? '' ) . ' depends on missing worker ' . $dependency_id . '.',
						'workerIds'    => array( (string) ( $worker['id'] ?? '' ) ),
						'dependencyId' => $dependency_id,
					);
					continue;
				}

				$dependency = $by_worker[ $dependency_id ];
				if ( 'succeeded' !== (string) ( $dependency['status'] ?? '' ) ) {
					$conflicts[] = array(
						'type'         => 'failed-worker-dependency',
						'severity'     => 'error',
						'message'      => 'Fanout worker ' . (string) ( $worker['id'] ?? '' ) . ' depends on ' . $dependency_id . ', which ended with status ' . (string) ( $dependency['status'] ?? '' ) . '.',
						'workerIds'    => array( (string) ( $worker['id'] ?? '' ), $dependency_id ),
						'dependencyId' => $dependency_id,
						'artifactRefs' => $dependency['artifactRefs'] ?? array(),
					);
				}
			}
		}

		return $conflicts;
	}

	private function normalize_error( mixed $error ): ?array {
		if ( ! is_array( $error ) ) {
			return null;
		}

		return array_filter(
			array(
				'code'    => is_string( $error['code'] ?? null ) ? $error['code'] : null,
				'message' => is_string( $error['message'] ?? null ) ? $error['message'] : 'Fanout worker failed.',
				'details' => is_array( $error['details'] ?? null ) ? $error['details'] : null,
			),
			static fn( mixed $value ): bool => null !== $value
		);
	}

	private function normalize_output_namespace( mixed $output_namespace ): string {
		$raw      = is_string( $output_namespace ) && '' !== $output_namespace ? $output_namespace : 'aggregate/final';
		$segments = array_filter(
			array_map(
				static fn( string $segment ): string => trim( preg_replace( '/[^a-zA-Z0-9._-]+/', '-', $segment ) ?? '', '-' ),
				explode( '/', $raw )
			),
			static fn( string $segment ): bool => '' !== $segment
		);

		return empty( $segments ) ? 'aggregate/final' : implode( '/', $segments );
	}
}
