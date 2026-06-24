<?php
/**
 * Generic host-side run-plan helpers.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Run_Plan {

	public const SCHEMA          = 'wp-codebox/run-plan/v1';
	public const EVENT_SCHEMA    = 'wp-codebox/run-plan-event/v1';
	public const PROGRESS_SCHEMA = 'wp-codebox/run-plan-progress/v1';
	public const RESULT_SCHEMA   = 'wp-codebox/run-plan-result/v1';

	/** @param array<string,mixed> $options Normalization options. */
	public function normalize_concurrency( mixed $value, array $options = array() ): int|WP_Error {
		$default = max( 1, (int) floor( (float) ( $options['default_concurrency'] ?? $options['defaultConcurrency'] ?? 1 ) ) );
		$max     = max( 1, (int) floor( (float) ( $options['max_concurrency'] ?? $options['maxConcurrency'] ?? PHP_INT_MAX ) ) );
		$mode    = (string) ( $options['concurrency_mode'] ?? $options['concurrencyMode'] ?? 'clamp' );
		$number  = is_numeric( $value ) ? (int) floor( (float) $value ) : $default;
		$number  = 0 === $number ? $default : $number;

		if ( 'validate' === $mode && ( $number < 1 || $number > $max ) ) {
			return new WP_Error( 'wp_codebox_run_plan_concurrency_invalid', 'Run plan concurrency must be between 1 and ' . $max . '.', array( 'status' => 400, 'max' => $max ) );
		}

		return max( 1, min( $max, $number ) );
	}

	/**
	 * @param array<int,array<string,mixed>> $workers Workers.
	 * @param array<string,mixed>            $options Normalization options.
	 * @return array<int,array<string,mixed>>|WP_Error
	 */
	public function normalize_worker_descriptors( array $workers, array $options = array() ): array|WP_Error {
		if ( empty( $workers ) ) {
			return new WP_Error( 'wp_codebox_run_plan_workers_missing', 'Run plan requires at least one worker.', array( 'status' => 400 ) );
		}

		$seen        = array();
		$descriptors = array();
		foreach ( $workers as $index => $worker ) {
			if ( ! is_array( $worker ) ) {
				return new WP_Error( 'wp_codebox_run_plan_worker_invalid', 'Each run plan worker must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$id = $this->safe_path_segment( $worker['id'] ?? '' );
			if ( is_wp_error( $id ) ) {
				$id->add_data( array_merge( is_array( $id->get_error_data() ) ? $id->get_error_data() : array(), array( 'index' => $index ) ) );
				return $id;
			}

			if ( isset( $seen[ $id ] ) ) {
				return new WP_Error( 'wp_codebox_run_plan_worker_id_duplicate', 'Run plan worker ids must be unique.', array( 'status' => 400, 'worker_id' => $id ) );
			}
			$seen[ $id ] = true;

			$goal = $this->string_value( $worker['goal'] ?? '' );
			if ( ! empty( $options['require_goal'] ) || ! empty( $options['requireGoal'] ) ) {
				if ( '' === $goal ) {
					return new WP_Error( 'wp_codebox_run_plan_worker_goal_missing', 'Run plan worker requires goal.', array( 'status' => 400, 'worker_id' => $id ) );
				}
			}

			$artifact_namespace = $this->safe_namespace( $worker['artifactNamespace'] ?? $worker['artifact_namespace'] ?? $id );
			if ( is_wp_error( $artifact_namespace ) ) {
				$artifact_namespace->add_data( array_merge( is_array( $artifact_namespace->get_error_data() ) ? $artifact_namespace->get_error_data() : array(), array( 'worker_id' => $id ) ) );
				return $artifact_namespace;
			}

			$worker['id'] = $id;
			if ( '' !== $goal ) {
				$worker['goal'] = $goal;
			}

			$descriptors[] = array(
				'id'                 => $id,
				'index'              => $index,
				'worker'             => $worker,
				'goal'               => $goal,
				'agent'              => $this->string_value( $worker['agent'] ?? $options['default_agent'] ?? $options['defaultAgent'] ?? '' ),
				'artifact_namespace' => $artifact_namespace,
				'required'           => false !== ( $worker['required'] ?? true ),
				'depends_on'         => $this->string_list( $worker['dependsOn'] ?? $worker['depends_on'] ?? array() ),
				'timeout_seconds'    => $this->positive_integer( $worker['timeoutSeconds'] ?? $worker['timeout_seconds'] ?? $worker['task_timeout_seconds'] ?? null ),
				'cancellation'       => $this->cancellation_metadata( $worker ),
			);
		}

		return $descriptors;
	}

	/**
	 * @param array<int,array<string,mixed>> $descriptors Worker descriptors.
	 * @return true|WP_Error
	 */
	public function validate_dependencies( array $descriptors ): true|WP_Error {
		$by_id = array();
		foreach ( $descriptors as $descriptor ) {
			$by_id[ (string) $descriptor['id'] ] = $descriptor;
		}

		foreach ( $descriptors as $descriptor ) {
			$id = (string) $descriptor['id'];
			foreach ( $descriptor['depends_on'] ?? array() as $dependency ) {
				$dependency = (string) $dependency;
				if ( $dependency === $id ) {
					return new WP_Error( 'wp_codebox_run_plan_dependency_self', 'Run plan worker cannot depend on itself.', array( 'status' => 400, 'worker_id' => $id ) );
				}
				if ( ! isset( $by_id[ $dependency ] ) ) {
					return new WP_Error( 'wp_codebox_run_plan_dependency_unknown', 'Run plan worker depends on unknown worker.', array( 'status' => 400, 'worker_id' => $id, 'dependency' => $dependency ) );
				}
			}
		}

		$visiting = array();
		$visited  = array();
		foreach ( $descriptors as $descriptor ) {
			$error = $this->visit_dependency( $descriptor, $by_id, $visiting, $visited );
			if ( is_wp_error( $error ) ) {
				return $error;
			}
		}

		return true;
	}

	/**
	 * Return deterministic dependency batches in worker input order.
	 *
	 * @param array<int,array<string,mixed>> $descriptors Worker descriptors.
	 * @return array<int,array<int,string>>|WP_Error
	 */
	public function dependency_batches( array $descriptors ): array|WP_Error {
		$valid = $this->validate_dependencies( $descriptors );
		if ( is_wp_error( $valid ) ) {
			return $valid;
		}

		$remaining = array_fill_keys( array_map( static fn( array $descriptor ): string => (string) $descriptor['id'], $descriptors ), true );
		$batches   = array();
		while ( ! empty( $remaining ) ) {
			$batch = array();
			foreach ( $descriptors as $descriptor ) {
				$id = (string) $descriptor['id'];
				if ( empty( $remaining[ $id ] ) ) {
					continue;
				}
				$dependencies = $descriptor['depends_on'] ?? array();
				if ( empty( array_filter( $dependencies, static fn( string $dependency ): bool => isset( $remaining[ $dependency ] ) ) ) ) {
					$batch[] = $id;
				}
			}

			if ( empty( $batch ) ) {
				return new WP_Error( 'wp_codebox_run_plan_dependency_unscheduled', 'Run plan dependencies could not be scheduled.', array( 'status' => 400 ) );
			}

			foreach ( $batch as $id ) {
				unset( $remaining[ $id ] );
			}
			$batches[] = $batch;
		}

		return $batches;
	}

	/** @param array<string,mixed> $source Source. @return array<string,mixed> */
	public function cancellation_metadata( array $source ): array {
		$timeout = $this->positive_integer( $source['timeoutSeconds'] ?? $source['timeout_seconds'] ?? $source['task_timeout_seconds'] ?? null );
		$reason  = $this->string_value( $source['cancelReason'] ?? $source['cancel_reason'] ?? '' );
		$deadline = $this->string_value( $source['deadline'] ?? '' );

		return array_filter(
			array(
				'cancel_requested' => (bool) ( $source['cancelRequested'] ?? $source['cancel_requested'] ?? $source['cancelled'] ?? false ),
				'reason'           => $reason,
				'timeout_seconds'  => $timeout,
				'deadline'         => $deadline,
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value
		);
	}

	/** @return array<string,string> */
	public function paths( string $base_artifacts, string $namespace ): array {
		$root      = rtrim( $base_artifacts, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . $namespace;
		$workers   = $root . DIRECTORY_SEPARATOR . 'workers';
		$aggregate = $root . DIRECTORY_SEPARATOR . 'aggregate';

		return array(
			'root'                   => $root,
			'workers'                => $workers,
			'aggregate'              => $aggregate,
			'aggregate_artifacts'    => $aggregate . DIRECTORY_SEPARATOR . 'artifacts',
			'aggregate_final'        => dirname( $root ) . DIRECTORY_SEPARATOR . 'aggregate' . DIRECTORY_SEPARATOR . 'final',
			'plan'                   => $root . DIRECTORY_SEPARATOR . 'plan.json',
			'events'                 => $root . DIRECTORY_SEPARATOR . 'events.jsonl',
			'result'                 => $root . DIRECTORY_SEPARATOR . 'result.json',
			'aggregate_result'       => $aggregate . DIRECTORY_SEPARATOR . 'result.json',
			'aggregate_final_result' => dirname( $root ) . DIRECTORY_SEPARATOR . 'aggregate' . DIRECTORY_SEPARATOR . 'final' . DIRECTORY_SEPARATOR . 'result.json',
		);
	}

	/** @param array<int,array<string,mixed>> $descriptors Worker descriptors. @return array<string,mixed> */
	public function plan( string $schema, string $session_id, int $concurrency, array $orchestrator, array $descriptors ): array {
		return array(
			'schema'       => $schema,
			'session_id'   => $session_id,
			'concurrency'  => $concurrency,
			'orchestrator' => $orchestrator,
			'workers'      => array_map(
				static fn( array $descriptor ): array => array_filter(
					array(
						'id'                 => (string) $descriptor['id'],
						'agent'              => (string) $descriptor['agent'],
						'goal'               => (string) $descriptor['goal'],
						'artifact_namespace' => (string) $descriptor['artifact_namespace'],
						'required'           => (bool) $descriptor['required'],
						'depends_on'         => $descriptor['depends_on'],
						'cancellation'       => $descriptor['cancellation'],
					),
					static fn( mixed $value ): bool => array() !== $value
				),
				$descriptors
			),
		);
	}

	/** @param array<int,array<string,mixed>> $runs Child run results. @return array{total:int,completed:int,failed:int,skipped:int,cancelled:int,timed_out:int} */
	public function result_counts( array $runs ): array {
		$completed = count( array_filter( $runs, static fn( array $run ): bool => true === ( $run['success'] ?? false ) ) );
		$skipped   = count( array_filter( $runs, static fn( array $run ): bool => 'skipped' === ( $run['status'] ?? '' ) ) );
		$cancelled = count( array_filter( $runs, static fn( array $run ): bool => 'cancelled' === ( $run['status'] ?? '' ) ) );
		$timed_out = count( array_filter( $runs, static fn( array $run ): bool => in_array( (string) ( $run['status'] ?? '' ), array( 'timed_out', 'timeout' ), true ) ) );

		return array(
			'total'     => count( $runs ),
			'completed' => $completed,
			'failed'    => count( $runs ) - $completed - $skipped - $cancelled - $timed_out,
			'skipped'   => $skipped,
			'cancelled' => $cancelled,
			'timed_out' => $timed_out,
		);
	}

	/** @param array{failed:int,skipped:int,cancelled:int,timed_out:int} $counts Counts. */
	public function succeeded( array $counts ): bool {
		return 0 === $counts['failed'] && 0 === $counts['skipped'] && 0 === $counts['cancelled'] && 0 === $counts['timed_out'];
	}

	/**
	 * @param array<string,mixed> $input Progress inputs.
	 * @return array<string,mixed>
	 */
	public function progress_snapshot( array $input = array() ): array {
		$plan    = is_array( $input['plan'] ?? null ) ? $input['plan'] : array();
		$workers = is_array( $input['workers'] ?? null ) ? $input['workers'] : ( is_array( $plan['workers'] ?? null ) ? $plan['workers'] : array() );
		$events  = is_array( $input['events'] ?? null ) ? $input['events'] : array();
		$results = is_array( $input['results'] ?? null ) ? $input['results'] : array();

		$worker_map = array();
		foreach ( $workers as $worker ) {
			if ( ! is_array( $worker ) ) {
				continue;
			}
			$id = $this->string_value( $worker['id'] ?? '' );
			if ( '' === $id || isset( $worker_map[ $id ] ) ) {
				continue;
			}
			$snapshot = array(
				'id'     => $id,
				'status' => 'queued',
			);
			if ( isset( $worker['required'] ) && is_bool( $worker['required'] ) ) {
				$snapshot['required'] = $worker['required'];
			}
			$artifact_namespace = $this->string_value( $worker['artifactNamespace'] ?? $worker['artifact_namespace'] ?? '' );
			if ( '' !== $artifact_namespace ) {
				$snapshot['artifactNamespace'] = $artifact_namespace;
			}
			$worker_map[ $id ] = $snapshot;
		}

		foreach ( $events as $event ) {
			if ( ! is_array( $event ) ) {
				continue;
			}
			$worker_id = $this->string_value( $event['workerId'] ?? $event['worker_id'] ?? '' );
			if ( '' === $worker_id ) {
				continue;
			}
			$current = $worker_map[ $worker_id ] ?? array( 'id' => $worker_id, 'status' => 'queued' );
			$status  = $this->progress_status_from_event( $event );
			if ( null !== $status ) {
				$current['status'] = $status;
			}
			$event_name = $this->string_value( $event['event'] ?? '' );
			if ( '' !== $event_name ) {
				$current['lastEvent'] = $event_name;
			}
			$time = $this->string_value( $event['time'] ?? '' );
			if ( '' !== $time && 'running' === $status ) {
				$current['startedAt'] = $time;
			} elseif ( '' !== $time && null !== $status ) {
				$current['completedAt'] = $time;
			}
			$worker_map[ $worker_id ] = $current;
		}

		foreach ( $results as $result ) {
			if ( ! is_array( $result ) ) {
				continue;
			}
			$worker_id = $this->string_value( $result['workerId'] ?? $result['worker_id'] ?? '' );
			if ( '' === $worker_id ) {
				continue;
			}
			$current                 = $worker_map[ $worker_id ] ?? array( 'id' => $worker_id, 'status' => 'queued' );
			$current['status']       = $this->progress_status_from_result( $result );
			$worker_map[ $worker_id ] = $current;
		}

		$workers_snapshot = array_values( $worker_map );
		$counts           = $this->progress_counts( $workers_snapshot );
		$snapshot         = array(
			'schema'  => self::PROGRESS_SCHEMA,
			'time'    => $this->string_value( $input['time'] ?? '' ) ?: gmdate( 'c' ),
			'status'  => $this->progress_status_from_counts( $counts ),
			'active'  => count( array_filter( $workers_snapshot, static fn( array $worker ): bool => 'running' === ( $worker['status'] ?? '' ) ) ),
			'counts'  => $counts,
			'workers' => $workers_snapshot,
		);

		foreach ( array( 'sessionId', 'runId', 'eventsRef', 'resultRef' ) as $key ) {
			$plan_key = 'runId' === $key ? 'id' : $key;
			$value    = $this->string_value( $input[ $key ] ?? $plan[ $key ] ?? $plan[ $plan_key ] ?? '' );
			if ( '' !== $value ) {
				$snapshot[ $key ] = $value;
			}
		}
		if ( isset( $input['metadata'] ) && is_array( $input['metadata'] ) ) {
			$snapshot['metadata'] = $input['metadata'];
		}

		return $snapshot;
	}

	/** @param array<string,string> $paths Run-plan artifact paths. @return array<string,mixed> */
	public function artifacts( string $schema, array $paths ): array {
		return array(
			'schema'         => $schema,
			'path'           => $paths['root'],
			'plan'           => 'plan.json',
			'events'         => 'events.jsonl',
			'workers_path'   => 'workers',
			'aggregate_path' => 'aggregate',
			'result'         => 'result.json',
		);
	}

	/** @param array<int,array<string,mixed>> $runs Child run results. @return array<int,array<string,mixed>> */
	public function failures( array $runs ): array {
		return array_values( array_filter( $runs, static fn( array $run ): bool => true !== ( $run['success'] ?? false ) ) );
	}

	/** @param array{completed:int,failed:int,skipped:int,cancelled:int,timed_out:int} $counts Counts. @return array<string,mixed> */
	public function aggregate_result( string $schema, string $status, array $counts ): array {
		return array(
			'schema'    => $schema,
			'status'    => $status,
			'completed' => $counts['completed'],
			'failed'    => $counts['failed'],
			'skipped'   => $counts['skipped'],
			'cancelled' => $counts['cancelled'],
			'timed_out' => $counts['timed_out'],
		);
	}

	/**
	 * @param array<string,mixed>             $descriptor Worker descriptor.
	 * @param array<string,array<string,mixed>> $by_id Worker map.
	 * @param array<string,bool>              $visiting Visiting set.
	 * @param array<string,bool>              $visited Visited set.
	 */
	private function visit_dependency( array $descriptor, array $by_id, array &$visiting, array &$visited ): true|WP_Error {
		$id = (string) $descriptor['id'];
		if ( isset( $visited[ $id ] ) ) {
			return true;
		}
		if ( isset( $visiting[ $id ] ) ) {
			return new WP_Error( 'wp_codebox_run_plan_dependency_cycle', 'Run plan dependencies contain a cycle.', array( 'status' => 400, 'worker_id' => $id ) );
		}
		$visiting[ $id ] = true;
		foreach ( $descriptor['depends_on'] ?? array() as $dependency ) {
			$error = $this->visit_dependency( $by_id[ (string) $dependency ], $by_id, $visiting, $visited );
			if ( is_wp_error( $error ) ) {
				return $error;
			}
		}
		unset( $visiting[ $id ] );
		$visited[ $id ] = true;

		return true;
	}

	/** @param array<string,mixed> $event Event data. @return array<string,mixed> */
	public function event( string $schema, array $event ): array {
		return array_merge( array( 'schema' => $schema, 'time' => gmdate( 'c' ) ), $event );
	}

	private function safe_path_segment( mixed $value ): string|WP_Error {
		$segment = $this->string_value( $value );
		if ( '' === $segment || ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9._-]*$/', $segment ) ) {
			return new WP_Error( 'wp_codebox_run_plan_path_segment_invalid', 'Run plan path segment must be safe.', array( 'status' => 400, 'segment' => $segment ) );
		}

		return $segment;
	}

	private function safe_namespace( mixed $value ): string|WP_Error {
		$namespace = $this->string_value( $value );
		if ( '' === $namespace ) {
			return new WP_Error( 'wp_codebox_run_plan_namespace_invalid', 'Run plan namespace must contain safe path segments.', array( 'status' => 400 ) );
		}

		foreach ( explode( '/', $namespace ) as $segment ) {
			if ( is_wp_error( $this->safe_path_segment( $segment ) ) ) {
				return new WP_Error( 'wp_codebox_run_plan_namespace_invalid', 'Run plan namespace must contain safe path segments.', array( 'status' => 400, 'namespace' => $namespace ) );
			}
		}

		return $namespace;
	}

	private function positive_integer( mixed $value ): ?int {
		$number = is_numeric( $value ) ? (int) floor( (float) $value ) : 0;
		return $number > 0 ? $number : null;
	}

	/** @return array<int,string> */
	private function string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		return array_values( array_filter( array_map( fn( mixed $item ): string => $this->string_value( $item ), $value ), static fn( string $item ): bool => '' !== $item ) );
	}

	private function string_value( mixed $value ): string {
		return trim( (string) ( $value ?? '' ) );
	}

	/** @param array<int,array<string,mixed>> $workers Workers. @return array{total:int,completed:int,failed:int,skipped:int,cancelled:int,timed_out:int} */
	private function progress_counts( array $workers ): array {
		$status_count = static fn( string $status ): int => count( array_filter( $workers, static fn( array $worker ): bool => $status === ( $worker['status'] ?? '' ) ) );
		return array(
			'total'     => count( $workers ),
			'completed' => $status_count( 'succeeded' ),
			'failed'    => $status_count( 'failed' ),
			'skipped'   => $status_count( 'skipped' ),
			'cancelled' => $status_count( 'cancelled' ),
			'timed_out' => $status_count( 'timed_out' ),
		);
	}

	/** @param array<string,mixed> $result Result. */
	private function progress_status_from_result( array $result ): string {
		if ( true === ( $result['success'] ?? false ) ) {
			return 'succeeded';
		}
		$status = $this->string_value( $result['status'] ?? '' );
		if ( 'timeout' === $status ) {
			return 'timed_out';
		}
		return in_array( $status, array( 'cancelled', 'skipped', 'timed_out' ), true ) ? $status : 'failed';
	}

	/** @param array<string,mixed> $event Event. */
	private function progress_status_from_event( array $event ): ?string {
		$label = $this->string_value( $event['event'] ?? '' ) . ' ' . $this->string_value( $event['status'] ?? '' );
		if ( preg_match( '/started|running/', $label ) ) {
			return 'running';
		}
		if ( preg_match( '/completed|succeeded|success/', $label ) ) {
			return 'succeeded';
		}
		if ( preg_match( '/cancelled|canceled/', $label ) ) {
			return 'cancelled';
		}
		if ( preg_match( '/timed[_ -]?out|timeout/', $label ) ) {
			return 'timed_out';
		}
		if ( preg_match( '/skipped/', $label ) ) {
			return 'skipped';
		}
		if ( preg_match( '/failed|error/', $label ) ) {
			return 'failed';
		}
		return null;
	}

	/** @param array{total:int,completed:int,failed:int,skipped:int,cancelled:int,timed_out:int} $counts Counts. */
	private function progress_status_from_counts( array $counts ): string {
		$settled = $counts['completed'] + $counts['failed'] + $counts['skipped'] + $counts['cancelled'] + $counts['timed_out'];
		if ( $settled < $counts['total'] ) {
			return 'running';
		}
		foreach ( array( 'timed_out', 'cancelled', 'failed', 'skipped' ) as $status ) {
			if ( $counts[ $status ] > 0 ) {
				return $status;
			}
		}
		return 'succeeded';
	}
}
