<?php
/**
 * WP_Codebox_Abilities_Runner_Publication implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Runner_Publication {
	/** @return array<string,mixed> */
	private static function runner_workspace_publication_input_schema(): array {
		$string_array = array( 'type' => 'array', 'items' => array( 'type' => 'string' ) );

		return array(
			'type'       => 'object',
			'required'   => array( 'workspace', 'repo', 'commit_message', 'title', 'body' ),
			'properties' => array(
				'schema'                => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-publication-request/v1' ),
				'workspace'             => array( 'type' => 'string', 'description' => 'Runner workspace handle. Alias: workspace_handle.' ),
				'workspace_handle'      => array( 'type' => 'string' ),
				'workspace_path'        => array( 'type' => 'string' ),
				'workspace_backend'     => array( 'type' => 'string' ),
				'runner_workspace'      => array( 'type' => 'object', 'description' => 'Opaque runner workspace identity and provenance.' ),
				'repo'                  => array( 'type' => 'string', 'description' => 'Target repository, for example Automattic/wp-codebox. Alias: target_repo.' ),
				'target_repo'           => array( 'type' => 'string' ),
				'base'                  => array( 'type' => 'string' ),
				'base_branch'           => array( 'type' => 'string' ),
				'head'                  => array( 'type' => 'string' ),
				'head_branch'           => array( 'type' => 'string' ),
				'commit_message'        => array( 'type' => 'string' ),
				'title'                 => array( 'type' => 'string', 'description' => 'Pull request title. Alias: pr_title.' ),
				'pr_title'              => array( 'type' => 'string' ),
				'body'                  => array( 'type' => 'string', 'description' => 'Pull request body. Alias: pr_body.' ),
				'pr_body'               => array( 'type' => 'string' ),
				'labels'                => $string_array,
				'draft'                 => array( 'type' => 'boolean' ),
				'maintainer_can_modify' => array( 'type' => 'boolean' ),
				'paths'                 => $string_array,
				'changed_paths'         => $string_array,
				'evidence_context'      => array( 'type' => 'object' ),
				'artifact_context'      => array( 'type' => 'object' ),
				'context'               => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function runner_workspace_publication_output_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'success'      => array( 'type' => 'boolean' ),
				'schema'       => array( 'type' => 'string', 'const' => 'wp-codebox/runner-workspace-publication-result/v1' ),
				'status'       => array( 'type' => 'string', 'enum' => array( 'published', 'failed', 'write_without_pr' ) ),
				'failure_type' => array( 'type' => 'string' ),
				'error'        => array( 'type' => 'object' ),
				'backend'      => array( 'type' => 'string' ),
				'workspace'    => array( 'type' => 'object' ),
				'branch'       => array( 'type' => 'object' ),
				'commit'       => array( 'type' => 'object' ),
				'pull_request' => array( 'type' => 'object' ),
				'reused'       => array( 'type' => 'boolean' ),
				'opened'       => array( 'type' => 'boolean' ),
				'evidence'     => array( 'type' => 'object' ),
				'artifacts'    => array( 'type' => 'object' ),
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	public static function publish_runner_workspace( array $input ): array {
		$normalized = self::normalize_runner_workspace_publication_input( $input );
		if ( is_array( $normalized['error'] ?? null ) ) {
			return self::runner_workspace_publication_failure( 'invalid_request', $normalized['error'], 'write_without_pr', $normalized );
		}

		$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( 'datamachine-code/publish-runner-workspace' ) : null;
		if ( ! $ability || ! is_callable( array( $ability, 'execute' ) ) ) {
			return self::runner_workspace_publication_failure(
				'publication_unavailable',
				array(
					'code'    => 'wp_codebox_runner_workspace_publication_unavailable',
					'message' => 'Runner workspace publication is not available in this WP Codebox runtime.',
				),
				'write_without_pr',
				$normalized
			);
		}

		$result = $ability->execute( self::runner_workspace_publication_backend_input( $normalized ) );
		if ( is_wp_error( $result ) ) {
			return self::runner_workspace_publication_failure(
				'backend_error',
				array(
					'code'    => $result->get_error_code(),
					'message' => $result->get_error_message(),
					'data'    => $result->get_error_data(),
				),
				'failed',
				$normalized
			);
		}

		if ( ! is_array( $result ) ) {
			return self::runner_workspace_publication_failure(
				'backend_invalid_response',
				array(
					'code'    => 'wp_codebox_runner_workspace_publication_invalid_response',
					'message' => 'Runner workspace publication backend returned an invalid response.',
				),
				'failed',
				$normalized
			);
		}

		if ( false === ( $result['success'] ?? true ) ) {
			$error = is_array( $result['error'] ?? null ) ? $result['error'] : array( 'message' => (string) ( $result['error'] ?? 'Runner workspace publication failed.' ) );
			return self::runner_workspace_publication_failure( (string) ( $result['failure_type'] ?? 'backend_failed' ), $error, 'failed', $normalized, $result );
		}

		return self::normalize_runner_workspace_publication_result( $result, $normalized );
	}

	/** @param array<string,mixed> $input Raw ability input. @return array<string,mixed> */
	private static function normalize_runner_workspace_publication_input( array $input ): array {
		$workspace = trim( (string) ( $input['workspace'] ?? $input['workspace_handle'] ?? '' ) );
		$repo      = trim( (string) ( $input['repo'] ?? $input['target_repo'] ?? '' ) );
		$title     = trim( (string) ( $input['title'] ?? $input['pr_title'] ?? '' ) );
		$body      = (string) ( $input['body'] ?? $input['pr_body'] ?? '' );
		$paths     = self::runner_publication_string_list( $input['paths'] ?? $input['changed_paths'] ?? array() );

		$normalized = array(
			'workspace'             => $workspace,
			'workspace_handle'      => $workspace,
			'workspace_path'        => trim( (string) ( $input['workspace_path'] ?? '' ) ),
			'workspace_backend'     => trim( (string) ( $input['workspace_backend'] ?? '' ) ),
			'runner_workspace'      => is_array( $input['runner_workspace'] ?? null ) ? $input['runner_workspace'] : array(),
			'repo'                  => $repo,
			'target_repo'           => $repo,
			'base'                  => trim( (string) ( $input['base'] ?? $input['base_branch'] ?? '' ) ),
			'head'                  => trim( (string) ( $input['head'] ?? $input['head_branch'] ?? '' ) ),
			'commit_message'        => trim( (string) ( $input['commit_message'] ?? '' ) ),
			'title'                 => $title,
			'pr_title'              => $title,
			'body'                  => $body,
			'pr_body'               => $body,
			'labels'                => self::runner_publication_string_list( $input['labels'] ?? array() ),
			'draft'                 => ! empty( $input['draft'] ),
			'maintainer_can_modify' => array_key_exists( 'maintainer_can_modify', $input ) ? (bool) $input['maintainer_can_modify'] : true,
			'paths'                 => $paths,
			'changed_paths'         => $paths,
			'evidence_context'      => is_array( $input['evidence_context'] ?? null ) ? $input['evidence_context'] : ( is_array( $input['context'] ?? null ) ? $input['context'] : array() ),
			'artifact_context'      => is_array( $input['artifact_context'] ?? null ) ? $input['artifact_context'] : array(),
			'context'               => is_array( $input['context'] ?? null ) ? $input['context'] : array(),
		);

		$missing = array();
		foreach ( array( 'workspace', 'repo', 'commit_message', 'title', 'body' ) as $field ) {
			if ( '' === (string) $normalized[ $field ] ) {
				$missing[] = $field;
			}
		}

		if ( array() !== $missing ) {
			$normalized['error'] = array(
				'code'    => 'wp_codebox_runner_workspace_publication_invalid_request',
				'message' => 'Runner workspace publication requires workspace, repo, commit_message, title, and body.',
				'missing' => $missing,
			);
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Normalized input. @return array<string,mixed> */
	private static function runner_workspace_publication_backend_input( array $input ): array {
		return array_filter(
			array(
				'workspace_handle'      => $input['workspace_handle'],
				'workspace'             => $input['workspace'],
				'workspace_path'        => $input['workspace_path'],
				'workspace_backend'     => $input['workspace_backend'],
				'runner_workspace'      => $input['runner_workspace'],
				'target_repo'           => $input['target_repo'],
				'repo'                  => $input['repo'],
				'base'                  => $input['base'],
				'head'                  => $input['head'],
				'commit_message'        => $input['commit_message'],
				'pr_title'              => $input['pr_title'],
				'title'                 => $input['title'],
				'pr_body'               => $input['pr_body'],
				'body'                  => $input['body'],
				'labels'                => $input['labels'],
				'draft'                 => $input['draft'],
				'maintainer_can_modify' => $input['maintainer_can_modify'],
				'changed_paths'         => $input['changed_paths'],
				'paths'                 => $input['paths'],
				'evidence_context'      => $input['evidence_context'],
				'artifact_context'      => $input['artifact_context'],
				'context'               => $input['context'],
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $result Backend response. @param array<string,mixed> $input Normalized input. @return array<string,mixed> */
	private static function normalize_runner_workspace_publication_result( array $result, array $input ): array {
		$workspace = is_array( $result['workspace'] ?? null ) ? $result['workspace'] : array();
		$branch    = is_array( $result['branch'] ?? null ) ? $result['branch'] : array();
		$commit    = is_array( $result['commit'] ?? null ) ? $result['commit'] : array();
		$pr        = is_array( $result['pull_request'] ?? null ) ? $result['pull_request'] : array();

		$backend = (string) ( $result['backend'] ?? $workspace['backend'] ?? $input['workspace_backend'] ?? 'unknown' );
		$sha     = (string) ( $commit['sha'] ?? $result['commit_sha'] ?? $result['commit'] ?? '' );
		$number  = (int) ( $pr['number'] ?? $result['pull_number'] ?? $result['pr_number'] ?? 0 );
		$url     = (string) ( $pr['url'] ?? $pr['html_url'] ?? $result['pr_url'] ?? $result['html_url'] ?? $result['url'] ?? '' );
		$reused  = (bool) ( $pr['reused'] ?? $result['reused'] ?? false );
		$opened  = array_key_exists( 'opened', $pr ) ? (bool) $pr['opened'] : ( array_key_exists( 'opened', $result ) ? (bool) $result['opened'] : ! $reused );

		return array_filter(
			array(
				'success'      => true,
				'schema'       => 'wp-codebox/runner-workspace-publication-result/v1',
				'status'       => 'published',
				'backend'      => $backend,
				'workspace'    => array_filter(
					array(
						'handle'  => (string) ( $workspace['handle'] ?? $workspace['name'] ?? $result['workspace_handle'] ?? $result['name'] ?? $input['workspace'] ),
						'path'    => (string) ( $workspace['path'] ?? $result['workspace_path'] ?? $input['workspace_path'] ),
						'backend' => $backend,
					),
					static fn( mixed $value ): bool => '' !== $value
				),
				'branch'       => array_filter(
					array(
						'base'   => (string) ( $branch['base'] ?? $result['base'] ?? $input['base'] ),
						'head'   => (string) ( $branch['head'] ?? $result['head'] ?? $input['head'] ),
						'name'   => (string) ( $branch['name'] ?? $result['branch'] ?? $input['head'] ),
						'remote' => (string) ( $branch['remote'] ?? $result['remote'] ?? '' ),
					),
					static fn( mixed $value ): bool => '' !== $value
				),
				'commit'       => array_filter( array( 'sha' => $sha, 'message' => (string) ( $commit['message'] ?? $input['commit_message'] ) ), static fn( mixed $value ): bool => '' !== $value ),
				'pull_request' => array_filter(
					array(
						'number' => $number > 0 ? $number : null,
						'url'    => $url,
						'reused' => $reused,
						'opened' => $opened,
					),
					static fn( mixed $value ): bool => null !== $value && '' !== $value
				),
				'reused'       => $reused,
				'opened'       => $opened,
				'evidence'     => $input['evidence_context'],
				'artifacts'    => $input['artifact_context'],
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value && null !== $value
		);
	}

	/** @param array<string,mixed> $error Error shape. @param array<string,mixed> $input Normalized input. @param array<string,mixed> $raw_result Raw backend result. @return array<string,mixed> */
	private static function runner_workspace_publication_failure( string $failure_type, array $error, string $status, array $input, array $raw_result = array() ): array {
		return array_filter(
			array(
				'success'      => false,
				'schema'       => 'wp-codebox/runner-workspace-publication-result/v1',
				'status'       => $status,
				'failure_type' => $failure_type,
				'error'        => $error,
				'backend'      => (string) ( $raw_result['backend'] ?? $input['workspace_backend'] ?? 'unavailable' ),
				'workspace'    => array_filter( array( 'handle' => (string) ( $input['workspace'] ?? '' ), 'path' => (string) ( $input['workspace_path'] ?? '' ) ), static fn( mixed $value ): bool => '' !== $value ),
				'branch'       => array_filter( array( 'base' => (string) ( $input['base'] ?? '' ), 'head' => (string) ( $input['head'] ?? '' ) ), static fn( mixed $value ): bool => '' !== $value ),
				'reused'       => false,
				'opened'       => false,
				'evidence'     => is_array( $input['evidence_context'] ?? null ) ? $input['evidence_context'] : array(),
				'artifacts'    => is_array( $input['artifact_context'] ?? null ) ? $input['artifact_context'] : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value && null !== $value
		);
	}

	/** @return array<int,string> */
	private static function runner_publication_string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		return array_values( array_filter( array_map( static fn( mixed $item ): string => trim( (string) $item ), $value ), static fn( string $item ): bool => '' !== $item ) );
	}
}
