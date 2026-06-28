<?php
/**
 * Artifact ability callback service for WP Codebox.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Artifact_Ability_Service {

	private const BROWSER_ARTIFACT_WRITE_SCOPE = 'artifact:write';

	public function __construct(
		private ?WP_Codebox_Artifacts $artifacts = null
	) {}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function list_artifacts( array $input = array() ): array|WP_Error {
		return $this->artifacts()->list( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function get_artifact( array $input ): array|WP_Error {
		return $this->artifacts()->get( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function inspect_artifact( array $input ): array|WP_Error {
		return $this->artifacts()->inspect( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function discard_artifact( array $input ): array|WP_Error {
		return $this->artifacts()->discard( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function normalize_browser_artifact_bundle( array $input ): array|WP_Error {
		return $this->artifacts()->normalize_browser_bundle( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function persist_browser_artifact( array $input ): array|WP_Error {
		$result = $this->artifacts()->persist_browser_bundle( $input );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		$authorization = $this->trusted_orchestrator_authorization( $input, self::BROWSER_ARTIFACT_WRITE_SCOPE );
		if ( ! empty( $authorization['caller'] ) || ! empty( $authorization['scope'] ) ) {
			$result['authorization'] = $authorization;
		}

		return $result;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function import_artifact_bundle( array $input ): array|WP_Error {
		return $this->artifacts()->import_artifact_bundle( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function reimport_artifact_bundle( array $input ): array|WP_Error {
		return $this->artifacts()->reimport_artifact_bundle( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function review_artifact( array $input ): array|WP_Error {
		return $this->artifacts()->review_artifact( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function apply_artifact_preflight( array $input ): array|WP_Error {
		return $this->artifacts()->apply_preflight( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function apply_approved_artifact( array $input ): array|WP_Error {
		return $this->artifacts()->apply_approved( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function stage_artifact_apply( array $input ): array|WP_Error {
		return WP_Codebox_Pending_Artifact_Apply::stage_apply_artifact( $input );
	}

	private function artifacts(): WP_Codebox_Artifacts {
		if ( null === $this->artifacts ) {
			$this->artifacts = new WP_Codebox_Artifacts();
		}

		return $this->artifacts;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private function trusted_orchestrator_authorization( array $input, string $required_scope ): array {
		$authorization = is_array( $input['authorization'] ?? null ) ? $input['authorization'] : array();
		$caller        = trim( (string) ( $authorization['caller'] ?? '' ) );
		$scope         = trim( (string) ( $authorization['scope'] ?? '' ) );
		$result        = array_filter(
			array(
				'schema'     => 'wp-codebox/trusted-orchestrator-authorization/v1',
				'caller'     => $caller,
				'scope'      => $scope,
				'authorized' => false,
				'method'     => 'trusted-orchestrator',
				'reason'     => 'missing-authorization',
			),
			static fn( mixed $value ): bool => '' !== $value
		);

		if ( '' === $caller ) {
			return $result;
		}

		if ( $required_scope !== $scope ) {
			$result['reason'] = 'missing-scope';
			return $result;
		}

		/**
		 * Filters trusted browser-session callers.
		 *
		 * @param array<int|string,mixed> $trusted_callers Trusted caller grants.
		 * @param array<string,mixed>     $authorization   Explicit caller authorization payload.
		 * @param array<string,mixed>     $input           Ability input.
		 */
		$trusted_callers = apply_filters( 'wp_codebox_trusted_browser_session_callers', array(), $authorization, $input );
		$trusted_callers = is_array( $trusted_callers ) ? $trusted_callers : array();

		if ( $this->trusted_browser_session_caller_has_scope( $trusted_callers, $caller, $scope ) ) {
			$result['authorized'] = true;
			$result['reason']     = 'trusted-caller-grant';
			return $result;
		}

		$result['reason'] = 'caller-not-trusted';

		return $result;
	}

	/** @param array<int|string,mixed> $trusted_callers Trusted caller grants. */
	private function trusted_browser_session_caller_has_scope( array $trusted_callers, string $caller, string $scope ): bool {
		foreach ( $trusted_callers as $key => $grant ) {
			if ( is_string( $key ) && $caller === $key ) {
				$scopes = is_array( $grant ) ? $grant : array( $grant );
				return in_array( $scope, array_map( 'strval', $scopes ), true );
			}

			if ( ! is_array( $grant ) || $caller !== (string) ( $grant['caller'] ?? '' ) ) {
				continue;
			}

			$scopes = is_array( $grant['scopes'] ?? null ) ? $grant['scopes'] : array( $grant['scope'] ?? '' );
			if ( in_array( $scope, array_map( 'strval', $scopes ), true ) ) {
				return true;
			}
		}

		return false;
	}
}
