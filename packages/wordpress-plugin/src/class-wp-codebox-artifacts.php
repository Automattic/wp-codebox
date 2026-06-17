<?php
/**
 * Parent-site WP Codebox artifact store and apply contract.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Artifacts {

	private const LIST_SCHEMA  = 'wp-codebox/artifact-list/v1';
	private const GET_SCHEMA   = 'wp-codebox/artifact/v1';
	private const BROWSER_ARTIFACT_GRANT_SCHEMA = 'wp-codebox/browser-artifact-grant/v1';
	private const BROWSER_ARTIFACT_REF_SCHEMA = 'wp-codebox/browser-artifact-ref/v1';
	private const BROWSER_PERSISTED_BUNDLE_SCHEMA = 'wp-codebox/browser-persisted-artifact-bundle/v1';
	private const APPLY_PREFLIGHT_SCHEMA = 'wp-codebox/artifact-apply-preflight/v1';
	private const APPLY_SCHEMA = 'wp-codebox/artifact-apply/v1';
	private const APPLY_RESULT_SCHEMA = 'wp-codebox/apply-result/v1';
	private const APPLY_AUDIT_SCHEMA = 'wp-codebox/apply-audit/v1';
	private const REVIEW_DECISION_SCHEMA = 'wp-codebox/artifact-review-decision/v1';
	private const REVIEW_DECISION_MESSAGE_TYPE = 'wp-codebox:artifact-review-decision';
	private const REVIEW_DECISION_RESULT_SCHEMA = 'wp-codebox/artifact-review-result/v1';
	private const REVIEW_AUDIT_SCHEMA = 'wp-codebox/artifact-review-audit/v1';
	private const VERIFICATION_SCHEMA = 'wp-codebox/artifact-bundle-verification/v1';
	private const BROWSER_NORMALIZATION_SCHEMA = 'wp-codebox/browser-artifact-bundle-normalization/v1';
	private const BROWSER_PERSIST_SCHEMA = 'wp-codebox/browser-artifact-persistence/v1';
	private const GENERIC_VERIFIER_ISSUE_URL = 'https://github.com/Automattic/wp-codebox/issues/176';
	private const CONTENT_DIGEST_PREFIX = "wp-codebox/artifact-content/v1\nfiles/changed-files.json\n";
	private const CONTENT_DIGEST_SEPARATOR = "\nfiles/patch.diff\n";
	private const BROWSER_ARTIFACT_MAX_BYTES = 5242880;

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function list( array $input = array() ): array|WP_Error {
		$root = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		$bundles = array();
		foreach ( $this->find_manifest_paths( $root ) as $manifest_path ) {
			$bundle = $this->read_bundle_at_manifest( $manifest_path, false );
			if ( ! is_wp_error( $bundle ) ) {
				$bundles[] = $bundle;
			}
		}

		usort(
			$bundles,
			static fn( array $a, array $b ): int => strcmp( (string) ( $b['created_at'] ?? '' ), (string) ( $a['created_at'] ?? '' ) )
		);

		return array(
			'success'   => true,
			'schema'    => self::LIST_SCHEMA,
			'root'      => $root,
			'artifacts' => $bundles,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function get( array $input ): array|WP_Error {
		$bundle = $this->resolve_bundle( $input );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}

		return array(
			'success'  => true,
			'schema'   => self::GET_SCHEMA,
			'artifact' => $bundle,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function discard( array $input ): array|WP_Error {
		$bundle = $this->resolve_bundle( $input );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}

		$directory = (string) $bundle['directory'];
		$root      = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		if ( ! $this->path_is_inside( $directory, $root ) ) {
			return new WP_Error( 'wp_codebox_artifact_outside_root', 'Artifact directory is outside the configured artifact root.', array( 'status' => 400 ) );
		}

		$this->remove_directory( $directory );

		return array(
			'success'     => true,
			'schema'      => self::GET_SCHEMA,
			'artifact_id' => (string) $bundle['id'],
			'discarded'   => true,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function normalize_browser_bundle( array $input, bool $include_bytes = false ): array|WP_Error {
		$schema_id = trim( (string) ( $input['schema_id'] ?? $input['caller_schema'] ?? $input['callerSchema'] ?? '' ) );
		if ( '' === $schema_id ) {
			return new WP_Error( 'wp_codebox_browser_artifact_schema_missing', 'schema_id is required for browser artifact bundle normalization.', array( 'status' => 400 ) );
		}

		$root = $this->normalize_browser_bundle_root( (string) ( $input['root'] ?? '' ) );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		$entrypoint = $this->normalize_browser_bundle_scoped_path( (string) ( $input['entrypoint'] ?? '' ), $root, -1, 'entrypoint' );
		if ( is_wp_error( $entrypoint ) ) {
			return $entrypoint;
		}

		$files = $this->browser_bundle_files( $input, $root );
		if ( is_wp_error( $files ) ) {
			return $files;
		}
		if ( empty( $files ) ) {
			return new WP_Error( 'wp_codebox_browser_artifact_files_missing', 'files must include at least one browser-produced artifact file.', array( 'status' => 400 ) );
		}

		$persistence_files = $files;
		usort( $files, static fn( array $a, array $b ): int => strcmp( (string) $a['path'], (string) $b['path'] ) );
		$entrypoint_found = false;
		$output_files      = array();
		foreach ( $files as $file ) {
			if ( $entrypoint === $file['path'] ) {
				$entrypoint_found = true;
			}

			$output_file = array(
				'path'      => $file['path'],
				'encoding'  => $file['encoding'],
				'mime_type' => $file['mime_type'],
				'size'      => strlen( $file['bytes'] ),
				'sha256'    => hash( 'sha256', $file['bytes'] ),
				'kind'      => $file['kind'],
			);
			if ( ! empty( $file['roles'] ) ) {
				$output_file['roles'] = $file['roles'];
			}
			if ( 'base64' === $file['encoding'] ) {
				$output_file['content_base64'] = base64_encode( $file['bytes'] );
			} else {
				$output_file['content'] = $file['bytes'];
			}

			$output_files[] = $output_file;
		}

		if ( ! $entrypoint_found ) {
			return new WP_Error( 'wp_codebox_browser_artifact_entrypoint_missing', 'Browser artifact bundle entrypoint must match one normalized file path.', array( 'status' => 400, 'entrypoint' => $entrypoint ) );
		}

		$bundle = array(
			'success'       => true,
			'schema'        => self::BROWSER_NORMALIZATION_SCHEMA,
			'caller_schema' => $schema_id,
			'root'          => $root,
			'entrypoint'    => $entrypoint,
			'files'         => $output_files,
			'roles'         => is_array( $input['roles'] ?? null ) ? $this->stable_assoc_array( $input['roles'] ) : array(),
			'provenance'    => is_array( $input['provenance'] ?? null ) ? $this->stable_assoc_array( $input['provenance'] ) : array(),
			'metadata'      => is_array( $input['metadata'] ?? null ) ? $this->stable_assoc_array( $input['metadata'] ) : array(),
		);
		$bundle['content_digest'] = hash( 'sha256', "wp-codebox/browser-artifact-bundle/v1\n" . $this->stable_json( $bundle ) );

		if ( $include_bytes ) {
			$bundle['_files'] = $persistence_files;
		}

		return $bundle;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function persist_browser_bundle( array $input ): array|WP_Error {
		$root = $this->artifact_root( $input, true );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		$normalization = $this->normalize_browser_bundle(
			array_merge(
				array(
					'schema_id'  => self::BROWSER_PERSIST_SCHEMA,
					'entrypoint' => (string) ( $input['entrypoint'] ?? ( is_array( $input['files'] ?? null ) && is_array( $input['files'][0] ?? null ) ? (string) ( $input['files'][0]['path'] ?? '' ) : '' ) ),
				),
				$input
			),
			true
		);
		if ( is_wp_error( $normalization ) ) {
			return $normalization;
		}
		$files = is_array( $normalization['_files'] ?? null ) ? $normalization['_files'] : array();

		$created_at = gmdate( 'c' );
		$tmp        = $root . DIRECTORY_SEPARATOR . '.browser-artifact-' . bin2hex( random_bytes( 8 ) );
		if ( ! $this->mkdir_p( $tmp . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'browser' ) ) {
			return new WP_Error( 'wp_codebox_artifact_directory_unwritable', 'Unable to create artifact bundle directory.', array( 'status' => 500 ) );
		}

		$changed_files = array(
			'schema' => 'wp-codebox/changed-files/v1',
			'files'  => array(),
		);
		$manifest_files = array();

		foreach ( $files as $file ) {
			$artifact_path = WP_Codebox_Path_Policy::normalize_artifact_relative_path( 'files/browser/' . $file['path'], 'Browser artifact file', 'wp_codebox_browser_artifact_path_invalid' );
			if ( is_wp_error( $artifact_path ) ) {
				$this->remove_directory( $tmp );
				return $artifact_path;
			}

			$target_path   = $this->resolve_artifact_file( $tmp, $artifact_path );
			$target_dir    = dirname( $target_path );
			if ( ! is_dir( $target_dir ) && ! $this->mkdir_p( $target_dir ) ) {
				$this->remove_directory( $tmp );
				return new WP_Error( 'wp_codebox_artifact_directory_unwritable', 'Unable to create artifact file directory.', array( 'status' => 500, 'path' => $artifact_path ) );
			}

			if ( false === file_put_contents( $target_path, $file['bytes'] ) ) {
				$this->remove_directory( $tmp );
				return new WP_Error( 'wp_codebox_artifact_file_unwritable', 'Unable to write artifact file.', array( 'status' => 500, 'path' => $artifact_path ) );
			}

			$file_sha256 = hash( 'sha256', $file['bytes'] );
			$changed_file = array(
				'path'         => $file['path'],
				'artifactPath' => $artifact_path,
				'status'       => 'created',
				'encoding'     => $file['encoding'],
				'mimeType'     => $file['mime_type'],
				'size'         => strlen( $file['bytes'] ),
				'sha256'       => array( 'algorithm' => 'sha256', 'value' => $file_sha256 ),
				'kind'         => $file['kind'],
			);
			foreach ( array( 'roles', 'metadata', 'provenance', 'description' ) as $field ) {
				if ( ! empty( $file[ $field ] ) ) {
					$changed_file[ $field ] = $file[ $field ];
				}
			}
			$changed_files['files'][] = $changed_file;
			$manifest_files[] = $this->manifest_file( $artifact_path, 'browser-artifact', $file['mime_type'], $file_sha256 );
		}

		$changed_files_json = $this->json_encode_pretty( $changed_files );
		$patch              = '';
		file_put_contents( $tmp . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'changed-files.json', $changed_files_json );
		file_put_contents( $tmp . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'patch.diff', $patch );

		$content_digest = hash( 'sha256', self::CONTENT_DIGEST_PREFIX . $changed_files_json . self::CONTENT_DIGEST_SEPARATOR . $patch );
		$bundle_id      = 'artifact-bundle-sha256-' . $content_digest;
		$destination    = $root . DIRECTORY_SEPARATOR . $bundle_id;
		if ( file_exists( $destination ) ) {
			$this->remove_directory( $tmp );
			$bundle = $this->read_bundle_at_manifest( $destination . DIRECTORY_SEPARATOR . 'manifest.json', true );
			if ( is_wp_error( $bundle ) ) {
				return $bundle;
			}
			$artifact_ref      = $this->browser_artifact_ref( $input, $bundle_id, $content_digest, $destination, 'existing' );
			$persisted_bundle = $this->browser_persisted_bundle_result( $input, $bundle, $artifact_ref );

			return array(
				'success'        => true,
				'schema'         => self::BROWSER_PERSIST_SCHEMA,
				'status'         => 'existing',
				'artifact_id'    => $bundle_id,
				'content_digest' => $content_digest,
				'directory'      => $destination,
				'artifact_ref'     => $artifact_ref,
				'persisted_bundle' => $persisted_bundle,
				'grant'            => $artifact_ref['grant'] ?? null,
				'artifact'         => $bundle,
			);
		}

		$provenance = is_array( $input['provenance'] ?? null ) ? $input['provenance'] : array();
		$caller     = $this->browser_caller_metadata( $input );
		$metadata   = array(
			'id'            => $bundle_id,
			'contentDigest' => array(
				'algorithm' => 'sha256',
				'inputs'    => array( 'files/changed-files.json', 'files/patch.diff' ),
				'value'     => $content_digest,
			),
			'createdAt'     => $created_at,
			'runtime'       => $this->browser_runtime_metadata( $input ),
			'provenance'    => $provenance,
			'caller'        => $caller,
			'artifacts'     => array(
				'browser'      => 'files/browser',
				'changedFiles' => 'files/changed-files.json',
				'patch'        => 'files/patch.diff',
				'review'       => 'files/review.json',
				'testResults'  => 'files/test-results.json',
			),
		);
		$review     = array(
			'schema'       => 'wp-codebox/artifact-review/v1',
			'artifactId'   => $bundle_id,
			'createdAt'    => $created_at,
			'summary'      => 'Browser-produced artifact files persisted as a canonical WP Codebox artifact bundle.',
			'provenance'   => $provenance,
			'reviewHints'  => is_array( $caller['reviewHints'] ?? null ) ? $caller['reviewHints'] : array(),
			'changedFiles' => $changed_files['files'],
			'evidence'     => array(
				'artifactContentDigest' => $content_digest,
				'changedFiles'          => 'files/changed-files.json',
				'patch'                 => 'files/patch.diff',
				'patchSha256'           => hash( 'sha256', $patch ),
			),
			'riskFlags'    => array(),
		);
		$test_results = array(
			'schema' => 'wp-codebox/test-results/v1',
			'status' => 'not-run',
			'tests'  => array(),
		);

		WP_Codebox_Json::write_file( $tmp . DIRECTORY_SEPARATOR . 'metadata.json', $metadata, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		WP_Codebox_Json::write_file( $tmp . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'review.json', $review, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		WP_Codebox_Json::write_file( $tmp . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'test-results.json', $test_results, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );

		$manifest = array(
			'id'            => $bundle_id,
			'contentDigest' => $metadata['contentDigest'],
			'createdAt'     => $created_at,
			'runtime'       => $metadata['runtime'],
			'files'         => array_merge(
				array(
					$this->manifest_file( 'manifest.json', 'manifest', 'application/json', str_repeat( '0', 64 ) ),
					$this->manifest_file( 'metadata.json', 'metadata', 'application/json', hash_file( 'sha256', $tmp . DIRECTORY_SEPARATOR . 'metadata.json' ) ),
					$this->manifest_file( 'files/changed-files.json', 'changed-files', 'application/json', hash( 'sha256', $changed_files_json ) ),
					$this->manifest_file( 'files/patch.diff', 'patch', 'text/x-diff', hash( 'sha256', $patch ) ),
					$this->manifest_file( 'files/review.json', 'review', 'application/json', hash_file( 'sha256', $tmp . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'review.json' ) ),
					$this->manifest_file( 'files/test-results.json', 'test-results', 'application/json', hash_file( 'sha256', $tmp . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'test-results.json' ) ),
				),
				$manifest_files
			),
		);
		$manifest['files'][0]['sha256']['value'] = $this->manifest_self_hash( $manifest );
		WP_Codebox_Json::write_file( $tmp . DIRECTORY_SEPARATOR . 'manifest.json', $manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );

		if ( ! rename( $tmp, $destination ) ) {
			$this->remove_directory( $tmp );
			return new WP_Error( 'wp_codebox_artifact_persist_failed', 'Unable to finalize artifact bundle directory.', array( 'status' => 500 ) );
		}

		$bundle = $this->read_bundle_at_manifest( $destination . DIRECTORY_SEPARATOR . 'manifest.json', true );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}
		$artifact_ref      = $this->browser_artifact_ref( $input, $bundle_id, $content_digest, $destination, 'created' );
		$persisted_bundle = $this->browser_persisted_bundle_result( $input, $bundle, $artifact_ref );

		return array(
			'success'        => true,
			'schema'         => self::BROWSER_PERSIST_SCHEMA,
			'status'         => 'created',
			'artifact_id'    => $bundle_id,
			'content_digest' => $content_digest,
			'directory'      => $destination,
			'artifact_ref'     => $artifact_ref,
			'persisted_bundle' => $persisted_bundle,
			'grant'            => $artifact_ref['grant'] ?? null,
			'artifact'         => $bundle,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function review_artifact( array $input ): array|WP_Error {
		$bundle = $this->resolve_bundle( $input );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}

		$root = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		$action = $this->review_action( $input );
		if ( is_wp_error( $action ) ) {
			return $action;
		}

		$verification = $this->verify_artifact_bundle( $bundle, $input );
		if ( is_wp_error( $verification ) ) {
			return $verification;
		}

		$approved_files = $this->approved_files( $input );
		if ( 'approve' === $action && empty( $approved_files ) ) {
			return new WP_Error( 'wp_codebox_approved_files_missing', 'approved_files must include at least one sandbox path for approve decisions.', array( 'status' => 400 ) );
		}

		$content_digest = $this->artifact_content_digest( $bundle );
		if ( is_wp_error( $content_digest ) ) {
			return $content_digest;
		}

		$decision = $this->review_decision_payload( $bundle, $input, $action, $approved_files, $content_digest );
		$message  = array(
			'type'    => self::REVIEW_DECISION_MESSAGE_TYPE,
			'payload' => $decision,
		);
		$adapter_payload = array(
			'decision'              => $decision,
			'message'               => $message,
			'artifact'              => $bundle,
			'artifact_verification' => $verification,
		);

		$result = apply_filters( 'wp_codebox_review_artifact_decision', null, $adapter_payload );
		if ( null === $result && 'approve' === $action ) {
			$apply_input = array(
				'artifacts_path'  => $root,
				'artifact_id'     => (string) $bundle['id'],
				'approved_files'  => $approved_files,
				'approver'        => $decision['approver'] ?? null,
				'apply_target'    => $decision['apply_target'] ?? null,
			);
			$result = $this->apply_approved( $apply_input );
		}

		$error = null;
		if ( is_wp_error( $result ) ) {
			$error = $result;
			$this->record_review_audit( $root, $bundle, $decision, null, $error );
			return $result;
		}

		$normalized_result = null === $result ? $this->default_review_result( $decision ) : $this->normalize_review_result( $result );
		if ( is_wp_error( $normalized_result ) ) {
			$this->record_review_audit( $root, $bundle, $decision, null, $normalized_result );
			return $normalized_result;
		}

		$this->record_review_audit( $root, $bundle, $decision, $normalized_result, null );

		return array(
			'success'        => true,
			'schema'         => self::REVIEW_DECISION_RESULT_SCHEMA,
			'artifact_id'    => (string) $bundle['id'],
			'action'         => $action,
			'approved_files' => $approved_files,
			'content_digest' => $content_digest,
			'verification'   => $verification,
			'decision'       => $decision,
			'message'        => $message,
			'result'         => $normalized_result,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function apply_preflight( array $input ): array|WP_Error {
		$preflight = $this->approved_artifact_apply_preflight( $input, true );
		if ( is_wp_error( $preflight ) ) {
			return $preflight;
		}

		return array_merge(
			array(
				'success' => true,
				'schema'  => self::APPLY_PREFLIGHT_SCHEMA,
			),
			$preflight
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function apply_approved( array $input ): array|WP_Error {
		$preflight = $this->approved_artifact_apply_preflight( $input, false );
		if ( is_wp_error( $preflight ) ) {
			return $preflight;
		}

		$bundle         = $preflight['artifact'];
		$approved_files = $preflight['approved_files'];
		$payload        = $preflight['payload'];
		$content_digest = (string) $preflight['content_digest'];
		$verification   = $preflight['verification'];

		$root = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		$result = apply_filters( 'wp_codebox_apply_approved_artifact', null, $payload );
		if ( null === $result ) {
			$this->record_apply_audit( $root, $bundle, $approved_files, $payload, null, new WP_Error( 'wp_codebox_apply_adapter_missing', 'No apply-back adapter handled this approved artifact.', array( 'status' => 501 ) ) );
			return new WP_Error( 'wp_codebox_apply_adapter_missing', 'No apply-back adapter handled this approved artifact.', array( 'status' => 501 ) );
		}

		if ( is_wp_error( $result ) ) {
			$this->record_apply_audit( $root, $bundle, $approved_files, $payload, null, $result );
			return $result;
		}

		$result = $this->normalize_apply_result( $result );
		if ( is_wp_error( $result ) ) {
			$this->record_apply_audit( $root, $bundle, $approved_files, $payload, null, $result );
			return $result;
		}

		$this->record_apply_audit( $root, $bundle, $approved_files, $payload, $result, null );

		return array(
			'success'        => true,
			'schema'         => self::APPLY_SCHEMA,
			'artifact_id'    => (string) $bundle['id'],
			'approved_files' => $approved_files,
			'patch_sha256'   => $payload['patch_sha256'],
			'content_digest' => $content_digest,
			'verification'   => $verification,
			'result'         => $result,
		);
	}

	/** @param array<string,mixed> $input Ability input. */
	private function review_action( array $input ): string|WP_Error {
		$action = trim( (string) ( $input['action'] ?? $input['decision'] ?? '' ) );
		if ( '' === $action ) {
			return new WP_Error( 'wp_codebox_review_action_missing', 'Review action is required.', array( 'status' => 400 ) );
		}

		if ( ! in_array( $action, array( 'approve', 'reject', 'request-changes' ), true ) ) {
			return new WP_Error( 'wp_codebox_review_action_invalid', 'Review action must be approve, reject, or request-changes.', array( 'status' => 400, 'action' => $action ) );
		}

		return $action;
	}

	/** @param array<string,mixed> $bundle Artifact bundle. @param array<string,mixed> $input Ability input. @param string[] $approved_files Approved sandbox paths. @return array<string,mixed> */
	private function review_decision_payload( array $bundle, array $input, string $action, array $approved_files, string $content_digest ): array {
		$context      = is_array( $input['context'] ?? null ) ? $input['context'] : array();
		$apply_target = is_array( $input['apply_target'] ?? null ) ? $input['apply_target'] : null;
		$provenance   = array(
			'artifact' => is_array( $bundle['metadata']['provenance'] ?? null ) ? $bundle['metadata']['provenance'] : array(),
			'review'   => is_array( $bundle['review']['provenance'] ?? null ) ? $bundle['review']['provenance'] : array(),
		);

		$decision = array(
			'schema'         => self::REVIEW_DECISION_SCHEMA,
			'action'         => $action,
			'artifact_id'    => (string) $bundle['id'],
			'approved_files' => $approved_files,
			'approver'       => $this->approver_principal( $input['approver'] ?? null ),
			'reason'         => $this->optional_string( $input['reason'] ?? null ),
			'decided_at'     => $this->optional_string( $input['decided_at'] ?? null ) ?? gmdate( 'c' ),
			'source'         => 'wp-codebox/wordpress-plugin',
			'provenance'     => $provenance,
			'content_digest' => $content_digest,
			'apply_target'   => $apply_target,
			'requester'      => $this->requester_principal( $bundle ),
			'context'        => empty( $context ) ? null : $context,
		);

		return $this->strip_null_values( $decision );
	}

	/** @param array<string,mixed> $decision Normalized decision. @return array<string,mixed> */
	private function default_review_result( array $decision ): array {
		return array(
			'schema'          => self::REVIEW_DECISION_RESULT_SCHEMA,
			'adapter'         => 'wp-codebox/default-review-decision',
			'status'          => (string) $decision['action'],
			'audit_reference' => (string) $decision['artifact_id'] . '#' . (string) $decision['decided_at'],
		);
	}

	/** @return array<string,mixed>|WP_Error */
	private function normalize_review_result( mixed $result ): array|WP_Error {
		if ( ! is_array( $result ) ) {
			return new WP_Error( 'wp_codebox_review_result_invalid', 'Review decision adapter returned an invalid result: result must be an object.', array( 'status' => 502 ) );
		}

		if ( isset( $result['schema'] ) && self::REVIEW_DECISION_RESULT_SCHEMA !== $result['schema'] && self::APPLY_SCHEMA !== $result['schema'] ) {
			return new WP_Error( 'wp_codebox_review_result_invalid', 'Review decision adapter returned an invalid result: schema is not supported.', array( 'status' => 502 ) );
		}

		if ( self::APPLY_SCHEMA === ( $result['schema'] ?? null ) ) {
			return $result;
		}

		$adapter = trim( (string) ( $result['adapter'] ?? '' ) );
		if ( '' === $adapter ) {
			return new WP_Error( 'wp_codebox_review_result_invalid', 'Review decision adapter returned an invalid result: result.adapter is required.', array( 'status' => 502 ) );
		}

		$status = trim( (string) ( $result['status'] ?? '' ) );
		if ( '' === $status ) {
			return new WP_Error( 'wp_codebox_review_result_invalid', 'Review decision adapter returned an invalid result: result.status is required.', array( 'status' => 502, 'adapter' => $adapter ) );
		}

		$normalized = array(
			'schema'  => self::REVIEW_DECISION_RESULT_SCHEMA,
			'adapter' => $adapter,
			'status'  => $status,
		);

		foreach ( array( 'audit_reference', 'url', 'pr_url', 'comment_url' ) as $key ) {
			if ( isset( $result[ $key ] ) && '' !== trim( (string) $result[ $key ] ) ) {
				$normalized[ $key ] = (string) $result[ $key ];
			}
		}

		if ( isset( $result['target'] ) && is_array( $result['target'] ) ) {
			$normalized['target'] = $result['target'];
		}

		return $normalized;
	}

	/** @return array<string,mixed>|WP_Error */
	private function normalize_apply_result( mixed $result ): array|WP_Error {
		if ( ! is_array( $result ) ) {
			return $this->invalid_apply_result( 'result must be an object.' );
		}

		if ( self::APPLY_RESULT_SCHEMA !== ( $result['schema'] ?? null ) ) {
			return $this->invalid_apply_result( 'result schema must be wp-codebox/apply-result/v1.' );
		}

		$adapter = trim( (string) ( $result['adapter'] ?? '' ) );
		if ( '' === $adapter ) {
			return $this->invalid_apply_result( 'result.adapter is required.' );
		}

		$status = trim( (string) ( $result['status'] ?? '' ) );
		if ( '' === $status ) {
			return $this->invalid_apply_result( 'result.status is required.', $adapter );
		}

		$target = $result['target'] ?? null;
		if ( ! is_array( $target ) ) {
			return $this->invalid_apply_result( 'result.target must be an object.', $adapter );
		}

		$applied_files = $result['applied_files'] ?? null;
		if ( ! is_array( $applied_files ) ) {
			return $this->invalid_apply_result( 'result.applied_files must be an array.', $adapter );
		}

		$applied_files = array_values(
			array_filter(
				array_map( static fn( $path ): string => trim( (string) $path ), $applied_files ),
				static fn( string $path ): bool => '' !== $path
			)
		);

		$audit_reference = trim( (string) ( $result['audit_reference'] ?? '' ) );
		if ( '' === $audit_reference ) {
			return $this->invalid_apply_result( 'result.audit_reference is required.', $adapter );
		}

		$normalized = array(
			'schema'          => self::APPLY_RESULT_SCHEMA,
			'adapter'         => $adapter,
			'status'          => $status,
			'target'          => $target,
			'applied_files'   => $applied_files,
			'audit_reference' => $audit_reference,
		);

		foreach ( array( 'commit', 'commit_url', 'pr_url', 'branch' ) as $key ) {
			if ( isset( $result[ $key ] ) && '' !== trim( (string) $result[ $key ] ) ) {
				$normalized[ $key ] = (string) $result[ $key ];
			}
		}

		return $normalized;
	}

	private function invalid_apply_result( string $message, ?string $adapter = null ): WP_Error {
		$data = array( 'status' => 502 );
		if ( null !== $adapter && '' !== $adapter ) {
			$data['adapter'] = $adapter;
		}

		return new WP_Error( 'wp_codebox_apply_result_invalid', 'Apply adapter returned an invalid result: ' . $message, $data );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function verify_resolved_bundle( array $input ): array|WP_Error {
		$bundle = $this->resolve_bundle( $input );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}

		return $this->verify_artifact_bundle( $bundle, $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function approved_artifact_apply_preflight( array $input, bool $require_all_changed_files_approved ): array|WP_Error {
		$bundle = $this->resolve_bundle( $input );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}

		$verification = $this->verify_artifact_bundle( $bundle, $input );
		if ( is_wp_error( $verification ) ) {
			return $verification;
		}

		$approved_files = $this->approved_files( $input );
		if ( empty( $approved_files ) ) {
			return new WP_Error( 'wp_codebox_approved_files_missing', 'approved_files must include at least one sandbox path.', array( 'status' => 400 ) );
		}

		$changed_files = $bundle['changed_files']['files'] ?? array();
		if ( ! is_array( $changed_files ) ) {
			return new WP_Error( 'wp_codebox_changed_files_invalid', 'Artifact changed-files payload is invalid.', array( 'status' => 400 ) );
		}

		$changed_paths = $this->changed_file_paths( $changed_files );
		$unknown_files = array_values( array_diff( $approved_files, $changed_paths ) );
		if ( ! empty( $unknown_files ) ) {
			return new WP_Error(
				'wp_codebox_approved_files_invalid',
				'approved_files contains paths that are not present in changed-files.json.',
				array(
					'status' => 400,
					'files'  => $unknown_files,
				)
			);
		}

		$missing_approved_files = $require_all_changed_files_approved ? array_values( array_diff( $changed_paths, $approved_files ) ) : array();
		if ( ! empty( $missing_approved_files ) ) {
			return new WP_Error(
				'wp_codebox_approved_files_incomplete',
				'approved_files must include every changed file for apply preflight.',
				array(
					'status' => 400,
					'files'  => $missing_approved_files,
				)
			);
		}

		$patch_path = (string) ( $bundle['paths']['patch'] ?? '' );
		$patch      = '' !== $patch_path && is_file( $patch_path ) ? file_get_contents( $patch_path ) : false;
		if ( false === $patch || '' === trim( $patch ) ) {
			return new WP_Error( 'wp_codebox_patch_missing', 'Artifact patch.diff is missing or empty.', array( 'status' => 400 ) );
		}

		$patch = ( new WP_Codebox_Patch_Approval_Filter() )->filter_patch_to_approved_files( $patch, $changed_files, $approved_files );
		if ( is_wp_error( $patch ) ) {
			return $patch;
		}

		$content_digest = $this->artifact_content_digest( $bundle );
		if ( is_wp_error( $content_digest ) ) {
			return $content_digest;
		}

		$payload = array(
			'artifact_id'             => (string) $bundle['id'],
			'artifact'                => $bundle,
			'approved_files'          => $approved_files,
			'approver'                => $input['approver'] ?? null,
			'apply_target'            => is_array( $input['apply_target'] ?? null ) ? $input['apply_target'] : null,
			'patch'                   => $patch,
			'patch_sha256'            => hash( 'sha256', $patch ),
			'artifact_content_digest' => $content_digest,
			'artifact_verification'   => $verification,
		);

		return array(
			'artifact_id'    => (string) $bundle['id'],
			'artifact'       => $bundle,
			'approved_files' => $approved_files,
			'changed_files'  => $changed_paths,
			'patch_sha256'   => $payload['patch_sha256'],
			'content_digest' => $content_digest,
			'verification'   => $verification,
			'payload'        => $payload,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function resolve_bundle( array $input ): array|WP_Error {
		$artifact_id = trim( (string) ( $input['artifact_id'] ?? '' ) );
		if ( '' === $artifact_id ) {
			return new WP_Error( 'wp_codebox_artifact_id_missing', 'artifact_id is required.', array( 'status' => 400 ) );
		}

		$root = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		foreach ( $this->find_manifest_paths( $root ) as $manifest_path ) {
			$bundle = $this->read_bundle_at_manifest( $manifest_path, true );
			if ( ! is_wp_error( $bundle ) && $artifact_id === (string) $bundle['id'] ) {
				return $bundle;
			}

			if ( is_wp_error( $bundle ) ) {
				$manifest = $this->read_json_file( $manifest_path );
				if ( ! is_wp_error( $manifest ) && $artifact_id === (string) ( $manifest['id'] ?? '' ) ) {
					return $bundle;
				}
			}
		}

		return new WP_Error( 'wp_codebox_artifact_not_found', 'Artifact bundle was not found under the configured artifact root.', array( 'status' => 404 ) );
	}

	/** @param array<string,mixed> $input Ability input. @return string|WP_Error */
	private function artifact_root( array $input, bool $create = false ): string|WP_Error {
		$root = trim( (string) ( $input['artifacts_path'] ?? '' ) );
		if ( '' === $root ) {
			$root = trim( (string) $this->config_option( 'wp_codebox_artifacts_root', '' ) );
			if ( '' === $root ) {
				$base = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir() );
				$root = is_array( $base ) && ! empty( $base['basedir'] ) ? (string) $base['basedir'] : sys_get_temp_dir();
				$root = rtrim( $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'wp-codebox';
			}
		}

		if ( function_exists( 'apply_filters' ) ) {
			$root = (string) apply_filters( 'wp_codebox_artifacts_root', $root, $input );
		}

		if ( $create && ! is_dir( $root ) && ! $this->mkdir_p( $root ) ) {
			return new WP_Error( 'wp_codebox_artifacts_root_unwritable', 'Artifact root could not be created.', array( 'status' => 500 ) );
		}

		$real = realpath( $root );
		if ( false === $real || ! is_dir( $real ) ) {
			return new WP_Error( 'wp_codebox_artifacts_root_missing', 'Artifact root is missing or not a directory.', array( 'status' => 400 ) );
		}

		return rtrim( $real, DIRECTORY_SEPARATOR );
	}

	private function config_option( string $name, mixed $default ): mixed {
		if ( function_exists( 'is_multisite' ) && is_multisite() && function_exists( 'get_site_option' ) ) {
			return get_site_option( $name, $default );
		}

		if ( function_exists( 'get_option' ) ) {
			return get_option( $name, $default );
		}

		return $default;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private function browser_bundle_files( array $input, string $root = '' ): array|WP_Error {
		$files      = is_array( $input['files'] ?? null ) ? $input['files'] : array();
		$normalized = array();
		$seen       = array();

		foreach ( $files as $index => $file ) {
			if ( ! is_array( $file ) ) {
				return new WP_Error( 'wp_codebox_browser_artifact_file_invalid', 'Each browser artifact file must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$path = $this->normalize_browser_bundle_scoped_path( (string) ( $file['path'] ?? '' ), $root, (int) $index, 'file' );
			if ( is_wp_error( $path ) ) {
				return $path;
			}
			if ( isset( $seen[ $path ] ) ) {
				return new WP_Error( 'wp_codebox_browser_artifact_path_duplicate', 'Browser artifact file paths must be unique.', array( 'status' => 400, 'index' => $index, 'path' => $path ) );
			}
			$seen[ $path ] = true;

			$encoding = strtolower( trim( (string) ( $file['encoding'] ?? '' ) ) );
			if ( '' === $encoding ) {
				$encoding = array_key_exists( 'content_base64', $file ) ? 'base64' : 'utf-8';
			}
			if ( ! in_array( $encoding, array( 'utf-8', 'base64' ), true ) ) {
				return new WP_Error( 'wp_codebox_browser_artifact_encoding_invalid', 'Browser artifact file encoding must be utf-8 or base64.', array( 'status' => 400, 'index' => $index, 'path' => $path, 'encoding' => $encoding ) );
			}

			if ( 'base64' === $encoding ) {
				$bytes = base64_decode( (string) ( $file['content_base64'] ?? $file['content'] ?? '' ), true );
				if ( false === $bytes ) {
					return new WP_Error( 'wp_codebox_browser_artifact_base64_invalid', 'Browser artifact file content_base64 must be valid base64.', array( 'status' => 400, 'index' => $index, 'path' => $path ) );
				}
			} else {
				$bytes = (string) ( $file['content'] ?? '' );
			}

			$size = strlen( $bytes );
			if ( $size > self::BROWSER_ARTIFACT_MAX_BYTES ) {
				return new WP_Error( 'wp_codebox_browser_artifact_file_too_large', 'Browser artifact file exceeds the maximum inline size.', array( 'status' => 400, 'index' => $index, 'path' => $path, 'size' => $size, 'max_size' => self::BROWSER_ARTIFACT_MAX_BYTES ) );
			}

			$mime_type = trim( (string) ( $file['mime_type'] ?? '' ) );
			if ( '' === $mime_type ) {
				$mime_type = $this->browser_bundle_mime_type( $path );
			}

			$normalized_file = array(
				'path'      => $path,
				'bytes'     => $bytes,
				'encoding'  => $encoding,
				'mime_type' => $mime_type,
				'kind'      => trim( (string) ( $file['kind'] ?? 'browser-artifact' ) ),
				'roles'     => array_values( array_filter( array_map( 'strval', is_array( $file['roles'] ?? null ) ? $file['roles'] : array() ), static fn( string $role ): bool => '' !== trim( $role ) ) ),
			);
			foreach ( array( 'metadata', 'provenance' ) as $field ) {
				if ( is_array( $file[ $field ] ?? null ) ) {
					$normalized_file[ $field ] = $this->stable_assoc_array( $file[ $field ] );
				}
			}
			$description = trim( (string) ( $file['description'] ?? '' ) );
			if ( '' !== $description ) {
				$normalized_file['description'] = $description;
			}

			$normalized[] = $normalized_file;
		}

		return $normalized;
	}

	private function normalize_browser_bundle_root( string $root ): string|WP_Error {
		$root = trim( str_replace( '\\', '/', $root ) );
		if ( '' === $root ) {
			return '';
		}

		return $this->validate_browser_bundle_file_path( $root, -1 );
	}

	private function normalize_browser_bundle_scoped_path( string $path, string $root, int $index, string $field ): string|WP_Error {
		$path = trim( str_replace( '\\', '/', $path ) );
		$path = $this->validate_browser_bundle_file_path( $path, $index );
		if ( is_wp_error( $path ) ) {
			return $path;
		}

		if ( '' === $root || $root === $path || str_starts_with( $path, $root . '/' ) ) {
			return $path;
		}

		$scoped = $this->validate_browser_bundle_file_path( $root . '/' . $path, $index );
		if ( is_wp_error( $scoped ) ) {
			return new WP_Error( $scoped->get_error_code(), $scoped->get_error_message(), array_merge( (array) $scoped->get_error_data(), array( 'field' => $field ) ) );
		}

		return $scoped;
	}

	private function validate_browser_bundle_file_path( string $path, int $index ): string|WP_Error {
		$normalized = WP_Codebox_Path_Policy::normalize_artifact_relative_path( $path, 'Browser artifact file path', 'wp_codebox_browser_artifact_path_invalid', array( 'index' => $index ) );
		if ( is_wp_error( $normalized ) ) {
			return $normalized;
		}

		$extension = strtolower( pathinfo( $normalized, PATHINFO_EXTENSION ) );
		if ( in_array( $extension, array( 'php', 'phtml', 'phar', 'cgi', 'pl', 'py', 'rb', 'asp', 'aspx', 'jsp' ), true ) ) {
			return new WP_Error( 'wp_codebox_browser_artifact_extension_blocked', 'Browser artifact files must not use executable server-side extensions.', array( 'status' => 400, 'index' => $index, 'path' => $normalized, 'extension' => $extension ) );
		}

		return $normalized;
	}

	private function browser_bundle_mime_type( string $path ): string {
		return match ( strtolower( pathinfo( $path, PATHINFO_EXTENSION ) ) ) {
			'html', 'htm' => 'text/html',
			'css'        => 'text/css',
			'js', 'mjs'  => 'text/javascript',
			'json'       => 'application/json',
			'svg'        => 'image/svg+xml',
			'jpg', 'jpeg' => 'image/jpeg',
			'png'        => 'image/png',
			'webp'       => 'image/webp',
			'gif'        => 'image/gif',
			'txt'        => 'text/plain',
			default      => 'application/octet-stream',
		};
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private function browser_runtime_metadata( array $input ): array {
		$session = is_array( $input['session'] ?? null ) ? $input['session'] : array();

		$runtime = array(
			'id'          => (string) ( $session['id'] ?? $input['session_id'] ?? 'browser-playground' ),
			'kind'        => 'browser-playground',
			'execution'   => 'browser-playground',
			'createdAt'   => (string) ( $session['created_at'] ?? $session['createdAt'] ?? '' ),
			'provenance'  => is_array( $session['provenance'] ?? null ) ? $session['provenance'] : array(),
		);

		foreach ( array( 'metadata', 'materialization' ) as $key ) {
			if ( is_array( $session[ $key ] ?? null ) ) {
				$runtime[ $key ] = $session[ $key ];
			}
		}

		return $runtime;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private function browser_caller_metadata( array $input ): array {
		$caller = is_array( $input['caller'] ?? null ) ? $input['caller'] : array();

		$scalar_fields = array(
			'caller_schema'    => 'schema',
			'caller_schema_id' => 'schemaId',
			'caller_kind'      => 'kind',
		);
		foreach ( $scalar_fields as $input_key => $caller_key ) {
			$value = trim( (string) ( $input[ $input_key ] ?? '' ) );
			if ( '' !== $value ) {
				$caller[ $caller_key ] = $value;
			}
		}

		$array_fields = array(
			'caller_metadata' => 'metadata',
			'materialization' => 'materialization',
			'review_hints'    => 'reviewHints',
			'apply_target'    => 'applyTarget',
		);
		foreach ( $array_fields as $input_key => $caller_key ) {
			if ( is_array( $input[ $input_key ] ?? null ) ) {
				$caller[ $caller_key ] = $input[ $input_key ];
			}
		}

		return $caller;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private function browser_artifact_grant( array $input, string $session_id, string $directory ): array {
		$authorization = is_array( $input['authorization'] ?? null ) ? $input['authorization'] : array();
		$caller        = trim( (string) ( $authorization['caller'] ?? $input['caller_id'] ?? $input['caller'] ?? '' ) );
		$scope         = trim( (string) ( $authorization['scope'] ?? '' ) );
		if ( '' === $caller || ( '' !== $scope && 'artifact:write' !== $scope ) ) {
			return array();
		}

		$grant = array(
			'schema'         => self::BROWSER_ARTIFACT_GRANT_SCHEMA,
			'scope'          => 'artifact:write',
			'session_id'     => $session_id,
			'authorization'  => array(
				'schema' => 'wp-codebox/trusted-orchestrator-authorization/v1',
				'caller' => $caller,
				'scope'  => 'artifact:write',
			),
			'artifacts_path' => $directory,
			'expires_at'     => $this->optional_string( $input['grant_expires_at'] ?? $input['expires_at'] ?? null ),
			'metadata'       => is_array( $input['grant_metadata'] ?? null ) ? $input['grant_metadata'] : null,
		);

		return $this->strip_null_values( $grant );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private function browser_artifact_ref( array $input, string $artifact_id, string $content_digest, string $directory, string $status ): array {
		$session_id = trim( (string) ( $input['session_id'] ?? ( is_array( $input['session'] ?? null ) ? (string) ( $input['session']['id'] ?? '' ) : '' ) ) );
		$grant      = '' === $session_id ? array() : $this->browser_artifact_grant( $input, $session_id, $directory );

		$ref = array(
			'schema'         => self::BROWSER_ARTIFACT_REF_SCHEMA,
			'artifact_id'    => $artifact_id,
			'content_digest' => $content_digest,
			'artifacts_path' => $directory,
			'status'         => $status,
			'session_id'     => '' === $session_id ? null : $session_id,
			'grant'          => empty( $grant ) ? null : $grant,
		);

		return $this->strip_null_values( $ref );
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $bundle Persisted artifact bundle. @param array<string,mixed> $artifact_ref Browser artifact reference. @return array<string,mixed> */
	private function browser_persisted_bundle_result( array $input, array $bundle, array $artifact_ref ): array {
		$changed_files = is_array( $bundle['changed_files']['files'] ?? null ) ? $bundle['changed_files']['files'] : array();
		$files         = array();
		foreach ( $changed_files as $file ) {
			if ( ! is_array( $file ) ) {
				continue;
			}

			$sha256 = is_array( $file['sha256'] ?? null ) ? (string) ( $file['sha256']['value'] ?? '' ) : (string) ( $file['sha256'] ?? '' );
			$files[] = $this->strip_null_values(
				array(
					'path'          => (string) ( $file['path'] ?? '' ),
					'artifact_path' => (string) ( $file['artifactPath'] ?? $file['artifact_path'] ?? '' ),
					'status'        => (string) ( $file['status'] ?? '' ),
					'encoding'      => (string) ( $file['encoding'] ?? '' ),
					'mime_type'     => (string) ( $file['mimeType'] ?? $file['mime_type'] ?? '' ),
					'size'          => isset( $file['size'] ) ? (int) $file['size'] : null,
					'sha256'        => '' === $sha256 ? null : array( 'algorithm' => 'sha256', 'value' => $sha256 ),
					'kind'          => (string) ( $file['kind'] ?? '' ),
					'roles'         => is_array( $file['roles'] ?? null ) ? array_values( $file['roles'] ) : null,
					'metadata'      => is_array( $file['metadata'] ?? null ) ? $file['metadata'] : null,
					'provenance'    => is_array( $file['provenance'] ?? null ) ? $file['provenance'] : null,
					'description'   => (string) ( $file['description'] ?? '' ),
				)
			);
		}

		$metadata = is_array( $bundle['metadata'] ?? null ) ? $bundle['metadata'] : array();
		$caller   = is_array( $metadata['caller'] ?? null ) ? $metadata['caller'] : $this->browser_caller_metadata( $input );

		return $this->strip_null_values(
			array(
				'schema'         => self::BROWSER_PERSISTED_BUNDLE_SCHEMA,
				'artifact_id'    => (string) ( $bundle['id'] ?? $artifact_ref['artifact_id'] ?? '' ),
				'content_digest' => (string) ( $bundle['content_digest'] ?? $artifact_ref['content_digest'] ?? '' ),
				'directory'      => (string) ( $bundle['directory'] ?? $artifact_ref['artifacts_path'] ?? '' ),
				'status'         => (string) ( $artifact_ref['status'] ?? '' ),
				'artifact_ref'   => $artifact_ref,
				'root'           => (string) ( $input['root'] ?? '' ),
				'entrypoint'     => (string) ( $input['entrypoint'] ?? '' ),
				'files'          => $files,
				'provenance'     => is_array( $metadata['provenance'] ?? null ) ? $metadata['provenance'] : null,
				'caller'         => empty( $caller ) ? null : $caller,
			)
		);
	}

	/** @return array<string,mixed> */
	private function manifest_file( string $path, string $kind, string $content_type, string $sha256 ): array {
		return array(
			'path'        => $path,
			'kind'        => $kind,
			'contentType' => $content_type,
			'sha256'      => array( 'algorithm' => 'sha256', 'value' => $sha256 ),
		);
	}

	private function manifest_self_hash( array $manifest ): string {
		foreach ( $manifest['files'] as &$file ) {
			if ( 'manifest.json' === ( $file['path'] ?? '' ) ) {
				$file['sha256'] = array( 'algorithm' => 'sha256', 'value' => str_repeat( '0', 64 ) );
			}
		}
		unset( $file );

		return hash( 'sha256', "wp-codebox/artifact-manifest-self/v1\n" . $this->stable_json( $manifest ) );
	}

	private function stable_json( mixed $value ): string {
		if ( ! is_array( $value ) ) {
			return (string) json_encode( $value, JSON_UNESCAPED_SLASHES );
		}

		if ( array_is_list( $value ) ) {
			return '[' . implode( ',', array_map( fn( mixed $item ): string => $this->stable_json( $item ), $value ) ) . ']';
		}

		ksort( $value, SORT_STRING );
		$parts = array();
		foreach ( $value as $key => $item ) {
			$parts[] = json_encode( (string) $key, JSON_UNESCAPED_SLASHES ) . ':' . $this->stable_json( $item );
		}

		return '{' . implode( ',', $parts ) . '}';
	}

	/** @param array<mixed> $value Input array. @return array<mixed> */
	private function stable_assoc_array( array $value ): array {
		if ( array_is_list( $value ) ) {
			return array_map( fn( mixed $item ): mixed => is_array( $item ) ? $this->stable_assoc_array( $item ) : $item, $value );
		}

		ksort( $value, SORT_STRING );
		foreach ( $value as $key => $item ) {
			if ( is_array( $item ) ) {
				$value[ $key ] = $this->stable_assoc_array( $item );
			}
		}

		return $value;
	}

	private function json_encode_pretty( mixed $value ): string {
		return WP_Codebox_Json::encode( $value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES, '{}' ) . "\n";
	}

	private function mkdir_p( string $path ): bool {
		if ( is_dir( $path ) ) {
			return true;
		}

		if ( function_exists( 'wp_mkdir_p' ) ) {
			return (bool) wp_mkdir_p( $path );
		}

		return mkdir( $path, 0777, true );
	}

	/** @return string[] */
	private function find_manifest_paths( string $root ): array {
		$paths = glob( $root . DIRECTORY_SEPARATOR . 'manifest.json' ) ?: array();
		foreach ( glob( $root . DIRECTORY_SEPARATOR . '*' . DIRECTORY_SEPARATOR . 'manifest.json' ) ?: array() as $path ) {
			$paths[] = $path;
		}
		foreach ( glob( $root . DIRECTORY_SEPARATOR . '*' . DIRECTORY_SEPARATOR . '*' . DIRECTORY_SEPARATOR . 'manifest.json' ) ?: array() as $path ) {
			$paths[] = $path;
		}

		return array_values(
			array_filter(
				array_unique( $paths ),
				fn( string $path ): bool => $this->path_is_inside( $path, $root )
			)
		);
	}

	/** @return array<string,mixed>|WP_Error */
	private function read_bundle_at_manifest( string $manifest_path, bool $include_contents ): array|WP_Error {
		$directory = dirname( $manifest_path );
		$manifest  = $this->read_json_file( $manifest_path );
		if ( is_wp_error( $manifest ) ) {
			return $manifest;
		}

		$id = trim( (string) ( $manifest['id'] ?? '' ) );
		if ( '' === $id ) {
			return new WP_Error( 'wp_codebox_manifest_invalid', 'Artifact manifest is missing an id.', array( 'status' => 400 ) );
		}

		$paths = array(
			'manifest'      => $manifest_path,
			'metadata'      => $this->resolve_artifact_file( $directory, 'metadata.json' ),
			'changed_files' => $this->resolve_artifact_file( $directory, 'files/changed-files.json' ),
			'patch'         => $this->resolve_artifact_file( $directory, 'files/patch.diff' ),
			'test_results'  => $this->resolve_artifact_file( $directory, 'files/test-results.json' ),
			'review'        => $this->resolve_artifact_file( $directory, 'files/review.json' ),
		);

		$bundle = array(
			'id'                => $id,
			'content_digest'    => is_array( $manifest['contentDigest'] ?? null ) ? (string) ( $manifest['contentDigest']['value'] ?? '' ) : '',
			'created_at'        => (string) ( $manifest['createdAt'] ?? '' ),
			'directory'         => $directory,
			'paths'             => $paths,
			'has_patch'         => is_file( $paths['patch'] ),
			'has_changed_files' => is_file( $paths['changed_files'] ),
			'has_test_results'  => is_file( $paths['test_results'] ),
			'has_review'        => is_file( $paths['review'] ),
		);

		if ( ! $include_contents ) {
			return $bundle;
		}

		$metadata      = is_file( $paths['metadata'] ) ? $this->read_json_file( $paths['metadata'] ) : array();
		$changed_files = is_file( $paths['changed_files'] ) ? $this->read_json_file( $paths['changed_files'] ) : array();
		$test_results  = is_file( $paths['test_results'] ) ? $this->read_json_file( $paths['test_results'] ) : array();
		$review        = is_file( $paths['review'] ) ? $this->read_json_file( $paths['review'] ) : array();
		if ( is_wp_error( $metadata ) ) {
			return $metadata;
		}
		if ( is_wp_error( $changed_files ) ) {
			return $changed_files;
		}
		if ( is_wp_error( $test_results ) ) {
			return $test_results;
		}
		if ( is_wp_error( $review ) ) {
			return $review;
		}

		$content_digest = $this->artifact_content_digest( $bundle );
		if ( is_wp_error( $content_digest ) ) {
			return $content_digest;
		}

		$declared_digest = (string) ( $bundle['content_digest'] ?? '' );
		if ( '' === $declared_digest ) {
			return new WP_Error( 'wp_codebox_artifact_digest_missing', 'Artifact manifest is missing contentDigest.value.', array( 'status' => 400 ) );
		}

		if ( ! hash_equals( $declared_digest, $content_digest ) ) {
			return new WP_Error( 'wp_codebox_artifact_digest_mismatch', 'Artifact content digest does not match changed-files.json and patch.diff.', array( 'status' => 400 ) );
		}

		$expected_id = 'artifact-bundle-sha256-' . $content_digest;
		if ( $expected_id !== $id ) {
			return new WP_Error( 'wp_codebox_artifact_id_mismatch', 'Artifact id does not match the content digest.', array( 'status' => 400 ) );
		}

		$bundle['manifest']      = $manifest;
		$bundle['metadata']      = $metadata;
		$bundle['changed_files'] = $changed_files;
		$bundle['test_results']  = $test_results;
		$bundle['review']        = $review;

		return $bundle;
	}

	/** @return array<string,mixed>|WP_Error */
	private function read_json_file( string $path ): array|WP_Error {
		$contents = is_file( $path ) ? file_get_contents( $path ) : false;
		if ( false === $contents ) {
			return new WP_Error( 'wp_codebox_artifact_file_missing', 'Artifact file is missing.', array( 'status' => 400, 'path' => $path ) );
		}

		$decoded = WP_Codebox_Json::decode_array( (string) $contents );
		if ( null === $decoded ) {
			return new WP_Error( 'wp_codebox_artifact_json_invalid', 'Artifact JSON could not be decoded.', array( 'status' => 400, 'path' => $path ) );
		}

		return $decoded;
	}

	/** @param array<string,mixed> $bundle Artifact bundle. */
	private function artifact_content_digest( array $bundle ): string|WP_Error {
		$changed_files_path = (string) ( $bundle['paths']['changed_files'] ?? '' );
		$patch_path         = (string) ( $bundle['paths']['patch'] ?? '' );
		$changed_files      = '' !== $changed_files_path && is_file( $changed_files_path ) ? file_get_contents( $changed_files_path ) : false;
		$patch              = '' !== $patch_path && is_file( $patch_path ) ? file_get_contents( $patch_path ) : false;

		if ( false === $changed_files ) {
			return new WP_Error( 'wp_codebox_changed_files_missing', 'Artifact changed-files.json is missing.', array( 'status' => 400 ) );
		}

		if ( false === $patch ) {
			return new WP_Error( 'wp_codebox_patch_missing', 'Artifact patch.diff is missing.', array( 'status' => 400 ) );
		}

		return hash( 'sha256', self::CONTENT_DIGEST_PREFIX . $changed_files . self::CONTENT_DIGEST_SEPARATOR . $patch );
	}

	/** @param array<string,mixed> $bundle Artifact bundle. @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function verify_artifact_bundle( array $bundle, array $input ): array|WP_Error {
		$directory = realpath( (string) ( $bundle['directory'] ?? '' ) );
		if ( false === $directory || ! is_dir( $directory ) ) {
			return new WP_Error( 'wp_codebox_artifact_directory_missing', 'Artifact bundle directory is missing.', array( 'status' => 400 ) );
		}

		$bin = trim( (string) ( $input['wp_codebox_bin'] ?? $this->default_bin() ) );
		if ( '' === $bin || ! preg_match( '#^[A-Za-z0-9_./:@+-]+$#', $bin ) ) {
			return new WP_Error( 'wp_codebox_bin_invalid', 'wp_codebox_bin must be a command name or path without shell metacharacters.', array( 'status' => 400 ) );
		}

		$result = WP_Codebox_Managed_Host_Command::run(
			array(
				'command'          => $this->artifact_verifier_command( $bin, $directory ),
				'cwd'              => $directory,
				'allowed_cwd_roots' => array( $directory ),
				'timeout_seconds'  => 60,
				'max_output_bytes' => 262144,
			)
		);
		if ( is_wp_error( $result ) ) {
			return $this->artifact_verifier_unavailable( $result->get_error_message(), array( 'error' => $result->get_error_data() ) );
		}

		$exit    = (int) $result['exit_code'];
		$raw     = trim( (string) $result['stdout'] . ( '' !== (string) $result['stderr'] ? "\n" . (string) $result['stderr'] : '' ) );
		$decoded = json_decode( $raw, true );

		if ( ! is_array( $decoded ) ) {
			return $this->artifact_verifier_unavailable( 'WP Codebox artifact verifier did not return valid JSON.', array( 'exit_code' => $exit, 'output' => $this->bound_output( $raw ) ) );
		}

		if ( self::VERIFICATION_SCHEMA !== ( $decoded['schema'] ?? '' ) || ! array_key_exists( 'valid', $decoded ) || ! is_array( $decoded['violations'] ?? null ) ) {
			return $this->artifact_verifier_unavailable( 'WP Codebox artifact verifier returned an unexpected payload.', array( 'exit_code' => $exit, 'output' => $decoded ) );
		}

		if ( true !== (bool) $decoded['valid'] ) {
			return new WP_Error(
				'wp_codebox_artifact_verification_failed',
				'Artifact bundle verification failed.',
				array(
					'status'       => 400,
					'schema'       => self::VERIFICATION_SCHEMA,
					'valid'        => false,
					'violations'   => $decoded['violations'],
					'verification' => $decoded,
					'issue_url'    => self::GENERIC_VERIFIER_ISSUE_URL,
				)
			);
		}

		if ( 0 !== $exit ) {
			return $this->artifact_verifier_unavailable( 'WP Codebox artifact verifier exited unsuccessfully.', array( 'exit_code' => $exit, 'output' => $decoded ) );
		}

		return $decoded;
	}

	/** @param array<string,mixed> $extra_data Additional WP_Error data. */
	private function artifact_verifier_unavailable( string $message, array $extra_data = array() ): WP_Error {
		return new WP_Error(
			'wp_codebox_artifact_verifier_unavailable',
			$message,
			array_merge(
				array(
					'status'    => 500,
					'issue_url' => self::GENERIC_VERIFIER_ISSUE_URL,
				),
				$extra_data
			)
		);
	}

	private function default_bin(): string {
		$bundled = defined( 'WP_CODEBOX_PLUGIN_PATH' ) ? WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox' : '';
		$default = is_string( $bundled ) && is_file( $bundled ) ? $bundled : 'wp-codebox';
		$bin     = (string) $this->config_option( 'wp_codebox_bin', $default );

		if ( function_exists( 'apply_filters' ) ) {
			$bin = (string) apply_filters( 'wp_codebox_bin', $bin );
		}

		return $bin;
	}

	/** @return string[] */
	private function artifact_verifier_command( string $bin, string $directory ): array {
		if ( str_ends_with( $bin, '.js' ) && is_file( $bin ) ) {
			return WP_Codebox_Managed_Host_Command::command( 'node', array( $bin, 'artifacts', 'verify', '--bundle', $directory, '--json' ) );
		}

		return WP_Codebox_Managed_Host_Command::command( $bin, array( 'artifacts', 'verify', '--bundle', $directory, '--json' ) );
	}

	private function bound_output( string $output ): string {
		if ( strlen( $output ) <= 4000 ) {
			return $output;
		}

		return substr( $output, 0, 4000 );
	}

	private function resolve_artifact_file( string $directory, string $relative_path ): string {
		$relative_path = WP_Codebox_Path_Policy::normalize_artifact_relative_path( $relative_path );
		if ( is_wp_error( $relative_path ) ) {
			return '';
		}

		$path = rtrim( $directory, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . str_replace( '/', DIRECTORY_SEPARATOR, $relative_path );
		$real = realpath( $path );

		return false !== $real ? $real : $path;
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function approved_files( array $input ): array {
		$files = is_array( $input['approved_files'] ?? null ) ? $input['approved_files'] : array();

		return array_values(
			array_unique(
				array_filter(
					array_map( static fn( $path ): string => trim( (string) $path ), $files ),
					static fn( string $path ): bool => '' !== $path
				)
			)
		);
	}

	/** @param array<int,mixed> $changed_files Artifact changed file entries. @return string[] */
	private function changed_file_paths( array $changed_files ): array {
		return array_values(
			array_filter(
				array_map(
					static fn( $file ): string => is_array( $file ) ? (string) ( $file['path'] ?? '' ) : '',
					$changed_files
				)
			)
		);
	}

	/**
	 * @param array<string,mixed> $bundle Artifact bundle.
	 * @param string[]            $approved_files Approved sandbox paths.
	 * @param array<string,mixed> $payload Apply adapter payload.
	 * @param mixed               $result Apply adapter result.
	 */
	private function record_apply_audit( string $root, array $bundle, array $approved_files, array $payload, mixed $result, ?WP_Error $error ): void {
		$record = array(
			'schema'         => self::APPLY_AUDIT_SCHEMA,
			'timestamp'      => gmdate( 'c' ),
			'artifact_id'    => (string) $bundle['id'],
			'content_digest' => (string) ( $payload['artifact_content_digest'] ?? $bundle['content_digest'] ?? '' ),
			'patch_sha256'   => (string) ( $payload['patch_sha256'] ?? '' ),
			'requester'      => $this->requester_principal( $bundle ),
			'approver'       => $this->approver_principal( $payload['approver'] ?? null ),
			'approved_files' => $approved_files,
			'adapter'        => is_array( $result ) ? ( $result['adapter'] ?? null ) : $this->adapter_from_error( $error ),
			'status'         => null === $error ? 'success' : 'failure',
		);

		if ( is_array( $result ) ) {
			$record['result'] = $this->redact_audit_metadata( $result );
		}

		if ( null !== $error ) {
			$record['error'] = array(
				'code'    => $error->get_error_code(),
				'message' => $error->get_error_message(),
				'data'    => $this->redact_audit_metadata( $error->get_error_data() ),
			);
		}

		$record = $this->strip_null_values( $record );
		if ( ! WP_Codebox_Json::append_jsonl( $this->apply_audit_path( $root ), $record, JSON_UNESCAPED_SLASHES, FILE_APPEND | LOCK_EX ) ) {
			return;
		}
	}

	/** @param array<string,mixed> $bundle Artifact bundle. @param array<string,mixed> $decision Normalized decision. @param mixed $result Review adapter result. */
	private function record_review_audit( string $root, array $bundle, array $decision, mixed $result, ?WP_Error $error ): void {
		$record = array(
			'schema'         => self::REVIEW_AUDIT_SCHEMA,
			'timestamp'      => gmdate( 'c' ),
			'artifact_id'    => (string) $bundle['id'],
			'action'         => (string) ( $decision['action'] ?? '' ),
			'content_digest' => (string) ( $decision['content_digest'] ?? $bundle['content_digest'] ?? '' ),
			'requester'      => $decision['requester'] ?? $this->requester_principal( $bundle ),
			'approver'       => $decision['approver'] ?? null,
			'approved_files' => is_array( $decision['approved_files'] ?? null ) ? $decision['approved_files'] : array(),
			'adapter'        => is_array( $result ) ? ( $result['adapter'] ?? null ) : $this->adapter_from_error( $error ),
			'status'         => null === $error ? 'success' : 'failure',
			'decision'       => $this->redact_audit_metadata( $decision ),
		);

		if ( is_array( $result ) ) {
			$record['result'] = $this->redact_audit_metadata( $result );
		}

		if ( null !== $error ) {
			$record['error'] = array(
				'code'    => $error->get_error_code(),
				'message' => $error->get_error_message(),
				'data'    => $this->redact_audit_metadata( $error->get_error_data() ),
			);
		}

		$record = $this->strip_null_values( $record );
		if ( ! WP_Codebox_Json::append_jsonl( $this->review_audit_path( $root ), $record, JSON_UNESCAPED_SLASHES, FILE_APPEND | LOCK_EX ) ) {
			return;
		}
	}

	private function apply_audit_path( string $root ): string {
		$path = $root . DIRECTORY_SEPARATOR . 'apply-audit.jsonl';

		if ( function_exists( 'apply_filters' ) ) {
			$path = (string) apply_filters( 'wp_codebox_apply_audit_path', $path, $root );
		}

		return $path;
	}

	private function review_audit_path( string $root ): string {
		$path = $root . DIRECTORY_SEPARATOR . 'review-audit.jsonl';

		if ( function_exists( 'apply_filters' ) ) {
			$path = (string) apply_filters( 'wp_codebox_review_audit_path', $path, $root );
		}

		return $path;
	}

	/** @param array<string,mixed> $bundle Artifact bundle. */
	private function requester_principal( array $bundle ): mixed {
		foreach ( array( 'metadata', 'review' ) as $section ) {
			$provenance = is_array( $bundle[ $section ]['provenance'] ?? null ) ? $bundle[ $section ]['provenance'] : array();
			$task       = is_array( $provenance['task'] ?? null ) ? $provenance['task'] : array();

			foreach ( array( 'requester', 'requested_by', 'principal', 'user' ) as $key ) {
				if ( ! empty( $task[ $key ] ) ) {
					return $task[ $key ];
				}
			}
		}

		return null;
	}

	private function approver_principal( mixed $input_approver ): mixed {
		if ( null !== $input_approver && '' !== $input_approver ) {
			return $input_approver;
		}

		if ( function_exists( 'wp_get_current_user' ) ) {
			$user = wp_get_current_user();
			if ( is_object( $user ) && ! empty( $user->ID ) ) {
				return array(
					'id'    => (int) $user->ID,
					'login' => (string) ( $user->user_login ?? '' ),
				);
			}
		}

		return null;
	}

	private function optional_string( mixed $value ): ?string {
		$trimmed = trim( (string) $value );

		return '' === $trimmed ? null : $trimmed;
	}

	private function adapter_from_error( ?WP_Error $error ): mixed {
		if ( null === $error ) {
			return null;
		}

		$data = $error->get_error_data();
		return is_array( $data ) ? ( $data['adapter'] ?? null ) : null;
	}

	private function redact_audit_metadata( mixed $value ): mixed {
		if ( ! is_array( $value ) ) {
			return $value;
		}

		$redacted = array();
		foreach ( $value as $key => $item ) {
			$normalized_key = strtolower( (string) $key );
			if ( $this->is_sensitive_audit_key( $normalized_key ) ) {
				$redacted[ $key ] = '[redacted]';
				continue;
			}

			$redacted[ $key ] = $this->redact_audit_metadata( $item );
		}

		return $redacted;
	}

	private function is_sensitive_audit_key( string $key ): bool {
		if ( in_array( $key, array( 'patch', 'patch_body', 'patch_diff', 'diff', 'body', 'content', 'contents' ), true ) ) {
			return true;
		}

		foreach ( array( 'secret', 'token', 'password', 'credential', 'authorization', 'private_key', 'api_key' ) as $needle ) {
			if ( str_contains( $key, $needle ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $record Audit record. @return array<string,mixed> */
	private function strip_null_values( array $record ): array {
		return array_filter( $record, static fn( mixed $value ): bool => null !== $value );
	}

	private function path_is_inside( string $path, string $root ): bool {
		$real_path = realpath( $path );
		$real_root = realpath( $root );
		if ( false === $real_path || false === $real_root ) {
			return false;
		}

		return str_starts_with( $real_path . DIRECTORY_SEPARATOR, rtrim( $real_root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR );
	}

	private function remove_directory( string $directory ): void {
		foreach ( scandir( $directory ) ?: array() as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}

			$path = $directory . DIRECTORY_SEPARATOR . $entry;
			if ( is_dir( $path ) && ! is_link( $path ) ) {
				$this->remove_directory( $path );
				continue;
			}

			unlink( $path );
		}

		rmdir( $directory );
	}
}
