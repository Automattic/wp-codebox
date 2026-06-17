<?php
/**
 * Managed host command primitive for PHP callsites.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Managed_Host_Command {

	/** @return array<string,mixed> */
	public static function run( array $config ): array|WP_Error {
		$command = self::string_list( $config['command'] ?? array() );
		if ( empty( $command ) || '' === $command[0] ) {
			return new WP_Error( 'wp_codebox_managed_host_command_invalid', 'Managed host command requires a command argv list.', array( 'status' => 400 ) );
		}

		if ( ! function_exists( 'proc_open' ) ) {
			return new WP_Error( 'wp_codebox_managed_host_command_unavailable', 'Managed host command execution requires proc_open support.', array( 'status' => 500 ) );
		}

		$cwd = self::resolve_cwd( (string) ( $config['cwd'] ?? getcwd() ), self::string_list( $config['allowed_cwd_roots'] ?? array() ) );
		if ( $cwd instanceof WP_Error ) {
			return $cwd;
		}

		$timeout_seconds  = max( 1, min( 3600, (int) ( $config['timeout_seconds'] ?? 60 ) ) );
		$max_output_bytes = max( 1024, min( 10485760, (int) ( $config['max_output_bytes'] ?? 262144 ) ) );
		$env              = self::environment( is_array( $config['env'] ?? null ) ? $config['env'] : array() );
		$started          = microtime( true );
		$process          = proc_open(
			$command,
			array(
				1 => array( 'pipe', 'w' ),
				2 => array( 'pipe', 'w' ),
			),
			$pipes,
			$cwd,
			$env
		);

		if ( ! is_resource( $process ) ) {
			return new WP_Error( 'wp_codebox_managed_host_command_failed', 'Failed to start managed host command.', array( 'status' => 500 ) );
		}

		foreach ( $pipes as $pipe ) {
			stream_set_blocking( $pipe, false );
		}

		$stdout           = '';
		$stderr           = '';
		$timed_out        = false;
		$status_exit_code = null;
		while ( true ) {
			$status = proc_get_status( $process );
			$stdout = self::append_bounded_output( $stdout, stream_get_contents( $pipes[1] ), $max_output_bytes );
			$stderr = self::append_bounded_output( $stderr, stream_get_contents( $pipes[2] ), $max_output_bytes );

			if ( ! (bool) ( $status['running'] ?? false ) ) {
				$status_exit_code = is_int( $status['exitcode'] ?? null ) ? (int) $status['exitcode'] : null;
				break;
			}

			if ( microtime( true ) - $started >= $timeout_seconds ) {
				$timed_out = true;
				proc_terminate( $process );
				break;
			}

			usleep( 10000 );
		}

		$stdout = self::append_bounded_output( $stdout, stream_get_contents( $pipes[1] ), $max_output_bytes );
		$stderr = self::append_bounded_output( $stderr, stream_get_contents( $pipes[2] ), $max_output_bytes );
		fclose( $pipes[1] );
		fclose( $pipes[2] );
		$closed_exit_code = proc_close( $process );
		$exit_code        = -1 !== $closed_exit_code ? $closed_exit_code : ( $status_exit_code ?? $closed_exit_code );

		return array(
			'success'          => ! $timed_out && 0 === $exit_code,
			'command'          => $command[0],
			'args'             => array_slice( $command, 1 ),
			'cwd'              => $cwd,
			'exit_code'        => $exit_code,
			'stdout'           => trim( $stdout ),
			'stderr'           => trim( $stderr ),
			'elapsed_ms'       => ( microtime( true ) - $started ) * 1000,
			'timed_out'        => $timed_out,
			'output_truncated' => strlen( $stdout ) >= $max_output_bytes || strlen( $stderr ) >= $max_output_bytes,
		);
	}

	/** @return string[] */
	public static function command( string $executable, array $args = array() ): array {
		return array_merge( array( $executable ), self::string_list( $args ) );
	}

	/** @return string[] */
	public static function split_command_line( string $command ): array {
		$tokens = str_getcsv( $command, ' ', '"', '\\' );

		return array_values( array_filter( array_map( 'strval', $tokens ), static fn( string $token ): bool => '' !== $token ) );
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		return array_values( array_map( 'strval', $value ) );
	}

	/** @param string[] $allowed_roots */
	private static function resolve_cwd( string $cwd, array $allowed_roots ): string|WP_Error {
		$real_cwd = realpath( '' !== $cwd ? $cwd : getcwd() );
		if ( false === $real_cwd || ! is_dir( $real_cwd ) ) {
			return new WP_Error( 'wp_codebox_managed_host_command_cwd_invalid', 'Managed host command cwd is invalid.', array( 'status' => 400, 'cwd' => $cwd ) );
		}

		$roots = empty( $allowed_roots ) ? array( $real_cwd ) : $allowed_roots;
		foreach ( $roots as $root ) {
			$real_root = realpath( $root );
			if ( false !== $real_root && self::path_is_same_or_child( $real_cwd, $real_root ) ) {
				return $real_cwd;
			}
		}

		return new WP_Error( 'wp_codebox_managed_host_command_cwd_denied', 'Managed host command cwd is outside allowed roots.', array( 'status' => 400, 'cwd' => $real_cwd ) );
	}

	/** @param array<string,mixed> $env */
	private static function environment( array $env ): array {
		$merged = array( 'PATH' => (string) getenv( 'PATH' ) );
		foreach ( $env as $name => $value ) {
			if ( is_string( $name ) && preg_match( '/^[A-Za-z_][A-Za-z0-9_]*$/', $name ) ) {
				$merged[ $name ] = (string) $value;
			}
		}

		return $merged;
	}

	private static function append_bounded_output( string $current, string|false $chunk, int $max_bytes ): string {
		if ( ! is_string( $chunk ) || '' === $chunk || strlen( $current ) >= $max_bytes ) {
			return $current;
		}

		return substr( $current . $chunk, 0, $max_bytes );
	}

	private static function path_is_same_or_child( string $path, string $root ): bool {
		$root = rtrim( $root, DIRECTORY_SEPARATOR );

		return $path === $root || str_starts_with( $path, $root . DIRECTORY_SEPARATOR );
	}
}
