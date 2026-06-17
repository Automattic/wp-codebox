<?php
/**
 * Host-side WP Codebox agent process execution helpers.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Agent_Process_Runner {

	/** @var array<string, callable> */
	private array $callbacks;

	/**
	 * @param array<string, callable> $callbacks Test seams for pure-PHP smoke coverage.
	 */
	public function __construct( array $callbacks = array() ) {
		$this->callbacks = $callbacks;
	}

	public function shell_available(): bool {
		if ( isset( $this->callbacks['shell_available'] ) ) {
			return (bool) ( $this->callbacks['shell_available'] )();
		}

		return function_exists( 'exec' ) && function_exists( 'shell_exec' );
	}

	/** @param array<string,string> $secret_env Secret env values for the child process. @return array{exit_code:int,output:string,timed_out?:bool,timeout_seconds?:int} */
	public function run_command( string $command, array $secret_env = array(), int $timeout_seconds = 0 ): array {
		if ( isset( $this->callbacks['command_runner'] ) ) {
			return ( $this->callbacks['command_runner'] )( $command, $secret_env, $timeout_seconds );
		}

		if ( ( ! empty( $secret_env ) || $timeout_seconds > 0 ) && ! function_exists( 'proc_open' ) ) {
			return array(
				'exit_code' => 1,
				'output'    => 'WP Codebox inherited secret environment or timeout requires proc_open support.',
			);
		}

		if ( ! empty( $secret_env ) || $timeout_seconds > 0 ) {
			$process = $this->open_process( $command, $secret_env, $pipes );
			if ( is_resource( $process ) ) {
				$output    = '';
				$error     = '';
				$started   = time();
				$timed_out = false;

				while ( true ) {
					$output .= (string) stream_get_contents( $pipes[1] );
					$error  .= (string) stream_get_contents( $pipes[2] );
					$status = proc_get_status( $process );
					if ( ! (bool) ( $status['running'] ?? false ) ) {
						break;
					}
					if ( $timeout_seconds > 0 && time() - $started >= $timeout_seconds ) {
						$timed_out = true;
						proc_terminate( $process );
						break;
					}
					usleep( 100000 );
				}

				$output .= (string) stream_get_contents( $pipes[1] );
				$error  .= (string) stream_get_contents( $pipes[2] );
				fclose( $pipes[1] );
				fclose( $pipes[2] );
				$exit_code = proc_close( $process );

				if ( $timed_out ) {
					return array(
						'exit_code'       => 124,
						'output'          => trim( (string) $output . "\n" . (string) $error . "\nWP Codebox task timed out after {$timeout_seconds} seconds." ),
						'timed_out'       => true,
						'timeout_seconds' => $timeout_seconds,
					);
				}

				return array(
					'exit_code' => $exit_code,
					'output'    => trim( (string) $output . "\n" . (string) $error ),
				);
			}
		}

		$output = array();
		$exit   = 0;
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.system_calls_exec -- Required host-side WP Codebox execution primitive.
		exec( $command . ' 2>&1', $output, $exit );

		return array(
			'exit_code' => $exit,
			'output'    => implode( "\n", $output ),
		);
	}

	/** @param array<string,mixed> $item Prepared worker item. @return array<string,mixed>|WP_Error */
	public function start_fanout_worker_process( array $item ): array|WP_Error {
		if ( ! function_exists( 'proc_open' ) ) {
			return new WP_Error( 'wp_codebox_proc_open_unavailable', 'Fanout execution requires proc_open support.', array( 'status' => 500 ) );
		}

		$prepared  = is_array( $item['prepared'] ?? null ) ? $item['prepared'] : array();
		$secret_env = is_array( $prepared['process_secret_env'] ?? null ) ? $prepared['process_secret_env'] : array();
		$process    = $this->open_process( (string) $prepared['command'], $secret_env, $pipes );
		if ( ! is_resource( $process ) ) {
			return new WP_Error( 'wp_codebox_fanout_worker_start_failed', 'Could not start fanout worker process.', array( 'status' => 500, 'worker_id' => (string) $item['id'] ) );
		}

		return array_merge(
			$item,
			array(
				'process'      => $process,
				'pipes'        => $pipes,
				'started_at'   => microtime( true ),
				'output'       => '',
				'error_output' => '',
			)
		);
	}

	/** @param array<string,mixed> $worker Active worker. @return array{worker:array<string,mixed>,result:array<string,mixed>|null} */
	public function capture_fanout_worker_process_result( array $worker ): array {
		$worker['output']       .= (string) stream_get_contents( $worker['pipes'][1] );
		$worker['error_output'] .= (string) stream_get_contents( $worker['pipes'][2] );
		$status                  = proc_get_status( $worker['process'] );
		$running                 = (bool) ( $status['running'] ?? false );
		$elapsed                 = microtime( true ) - (float) $worker['started_at'];
		$timeout                 = (int) ( $worker['prepared']['timeout_seconds'] ?? 0 );

		if ( $running && $timeout > 0 && $elapsed >= $timeout ) {
			proc_terminate( $worker['process'] );
			$worker['timed_out'] = true;
			$running             = false;
		}

		if ( $running ) {
			return array(
				'worker' => $worker,
				'result' => null,
			);
		}

		$worker['output']       .= (string) stream_get_contents( $worker['pipes'][1] );
		$worker['error_output'] .= (string) stream_get_contents( $worker['pipes'][2] );
		fclose( $worker['pipes'][1] );
		fclose( $worker['pipes'][2] );
		$exit_code = proc_close( $worker['process'] );
		if ( true === ( $worker['timed_out'] ?? false ) ) {
			$exit_code = 124;
		}

		$result = array(
			'exit_code' => $exit_code,
			'output'    => trim( (string) $worker['output'] . "\n" . (string) $worker['error_output'] ),
		);
		if ( true === ( $worker['timed_out'] ?? false ) ) {
			$result['timed_out']       = true;
			$result['timeout_seconds'] = $timeout;
		}

		return array(
			'worker' => $worker,
			'result' => $result,
		);
	}

	/** @param array<string,string> $secret_env Secret env values for the child process. */
	private function open_process( string $command, array $secret_env, mixed &$pipes ): mixed {
		$descriptor_spec = array(
			1 => array( 'pipe', 'w' ),
			2 => array( 'pipe', 'w' ),
		);
		$current_env     = getenv();
		$process         = proc_open( $command, $descriptor_spec, $pipes, null, array_merge( is_array( $current_env ) ? $current_env : array(), $_ENV, $secret_env ) );

		if ( is_resource( $process ) ) {
			stream_set_blocking( $pipes[1], false );
			stream_set_blocking( $pipes[2], false );
		}

		return $process;
	}
}
