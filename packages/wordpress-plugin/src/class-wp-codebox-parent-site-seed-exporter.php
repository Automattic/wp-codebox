<?php
/**
 * Bounded parent-site seed export for host-created sandbox recipes.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Parent_Site_Seed_Exporter {

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @return array{siteSeeds:array<int,array<string,mixed>>,cleanup_paths:array<int,string>}|WP_Error
	 */
	public function recipe_entries( array $input ): array|WP_Error {
		$declarations = is_array( $input['site_seeds'] ?? null ) ? $input['site_seeds'] : array();
		if ( empty( $declarations ) ) {
			return array( 'siteSeeds' => array(), 'cleanup_paths' => array() );
		}

		$site_seeds    = array();
		$cleanup_paths = array();
		foreach ( $declarations as $index => $declaration ) {
			if ( ! is_array( $declaration ) ) {
				return new WP_Error( 'wp_codebox_site_seed_invalid', 'Each site_seeds entry must be an object.', array( 'status' => 400, 'index' => $index ) );
			}
			if ( 'parent_site' !== (string) ( $declaration['type'] ?? '' ) ) {
				return new WP_Error( 'wp_codebox_site_seed_type_invalid', 'Only parent_site site_seeds are accepted by the WordPress host exporter.', array( 'status' => 400, 'index' => $index ) );
			}
			$name = (string) ( $declaration['name'] ?? 'parent-site' );
			if ( ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9_.-]*$/', $name ) ) {
				return new WP_Error( 'wp_codebox_site_seed_name_invalid', 'site_seeds entries require a stable name.', array( 'status' => 400, 'index' => $index ) );
			}
			$scopes     = is_array( $declaration['scopes'] ?? null ) ? $declaration['scopes'] : array();
			$validation = $this->validate_scopes( $scopes );
			if ( is_wp_error( $validation ) ) {
				return $validation;
			}

			$seed = $this->export( $name, $scopes );
			if ( is_wp_error( $seed ) ) {
				return $seed;
			}

			$file = tempnam( sys_get_temp_dir(), 'wp-codebox-site-seed-' );
			if ( false === $file ) {
				return new WP_Error( 'wp_codebox_site_seed_temp_failed', 'Could not create a temporary WP Codebox site seed fixture.', array( 'status' => 500 ) );
			}

			$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $seed, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : json_encode( $seed, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
			if ( ! is_string( $encoded ) || false === file_put_contents( $file, $encoded ) ) {
				@unlink( $file );
				return new WP_Error( 'wp_codebox_site_seed_write_failed', 'Could not write a temporary WP Codebox site seed fixture.', array( 'status' => 500 ) );
			}

			$cleanup_paths[] = $file;
			$site_seeds[]    = array(
				'type'   => 'fixture',
				'name'   => $name,
				'source' => $file,
				'format' => 'json',
				'scopes' => $scopes,
			);
		}

		return array( 'siteSeeds' => $site_seeds, 'cleanup_paths' => $cleanup_paths );
	}

	/** @param array<string,mixed> $scopes Parent-site seed scopes. */
	private function validate_scopes( array $scopes ): true|WP_Error {
		if ( empty( $scopes ) ) {
			return new WP_Error( 'wp_codebox_site_seed_scopes_missing', 'parent_site site_seeds require explicit scopes.', array( 'status' => 400 ) );
		}

		foreach ( array( 'posts', 'terms', 'options', 'users', 'media' ) as $scope_name ) {
			$scope = $scopes[ $scope_name ] ?? null;
			if ( null === $scope ) {
				continue;
			}
			if ( ! is_array( $scope ) ) {
				return new WP_Error( 'wp_codebox_site_seed_scope_invalid', 'Record site seed scopes must be objects.', array( 'status' => 400, 'scope' => $scope_name ) );
			}
			$max = isset( $scope['maxRecords'] ) ? (int) $scope['maxRecords'] : 0;
			if ( $max < 1 || $max > 100 ) {
				return new WP_Error( 'wp_codebox_site_seed_scope_unbounded', 'Parent-site record scopes require maxRecords between 1 and 100.', array( 'status' => 400, 'scope' => $scope_name ) );
			}
		}

		if ( isset( $scopes['options'] ) && empty( $scopes['options']['names'] ) ) {
			return new WP_Error( 'wp_codebox_site_seed_options_unbounded', 'Parent-site option seeds require an explicit names allow-list.', array( 'status' => 400 ) );
		}
		if ( isset( $scopes['users'] ) && false === ( $scopes['users']['anonymize'] ?? true ) ) {
			return new WP_Error( 'wp_codebox_site_seed_users_unsafe', 'Parent-site user seeds must be anonymized.', array( 'status' => 400 ) );
		}
		if ( isset( $scopes['media'] ) && true === ( $scopes['media']['includeFiles'] ?? false ) ) {
			return new WP_Error( 'wp_codebox_site_seed_media_files_unsupported', 'Parent-site media seed export includes metadata only; file export is not supported.', array( 'status' => 400 ) );
		}

		return true;
	}

	/** @param array<string,mixed> $scopes Parent-site seed scopes. @return array<string,mixed>|WP_Error */
	private function export( string $name, array $scopes ): array|WP_Error {
		$seed = array(
			'schema'     => 'wp-codebox/site-seed-fixture/v1',
			'name'       => $name,
			'provenance' => array(
				'source'      => 'parent_site',
				'source_url'  => function_exists( 'home_url' ) ? home_url( '/' ) : '',
				'exported_at' => gmdate( 'c' ),
				'limitations' => array(
					'media file bytes are not exported',
					'user credentials and raw user emails are not exported',
					'full database state, revisions, comments, post meta, term meta, and arbitrary options are not replayed',
				),
			),
		);

		if ( isset( $scopes['posts'] ) ) {
			$seed['posts'] = $this->export_posts( $scopes['posts'] );
		}
		if ( isset( $scopes['terms'] ) ) {
			$seed['terms'] = $this->export_terms( $scopes['terms'] );
		}
		if ( isset( $scopes['options'] ) ) {
			$seed['options'] = $this->export_options( $scopes['options'] );
		}
		if ( isset( $scopes['users'] ) ) {
			$seed['users'] = $this->export_users( $scopes['users'] );
		}
		if ( isset( $scopes['media'] ) ) {
			$seed['media'] = $this->export_media( $scopes['media'] );
		}
		if ( true === ( $scopes['activePlugins'] ?? false ) ) {
			$seed['activePlugins'] = array_slice( array_values( (array) get_option( 'active_plugins', array() ) ), 0, 100 );
		}
		if ( true === ( $scopes['activeTheme'] ?? false ) && function_exists( 'get_stylesheet' ) ) {
			$seed['activeTheme'] = get_stylesheet();
		}

		return $seed;
	}

	/** @param array<string,mixed> $scope Parent-site posts scope. @return array<int,array<string,mixed>> */
	private function export_posts( array $scope ): array {
		$query = array(
			'post_type'      => ! empty( $scope['postTypes'] ) && is_array( $scope['postTypes'] ) ? array_map( 'sanitize_key', $scope['postTypes'] ) : array( 'post', 'page' ),
			'post_status'    => ! empty( $scope['statuses'] ) && is_array( $scope['statuses'] ) ? array_map( 'sanitize_key', $scope['statuses'] ) : array( 'publish' ),
			'posts_per_page' => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby'        => 'ID',
			'order'          => 'ASC',
			'no_found_rows'  => true,
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$query['post__in'] = array_map( 'absint', $scope['ids'] );
			$query['orderby']  = 'post__in';
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$query['post_name__in'] = array_map( 'sanitize_title', $scope['slugs'] );
		}

		$posts = function_exists( 'get_posts' ) ? get_posts( $query ) : array();
		return array_map(
			static fn( WP_Post $post ): array => array(
				'id'           => (int) $post->ID,
				'post_type'    => $post->post_type,
				'post_status'  => $post->post_status,
				'post_name'    => $post->post_name,
				'post_title'   => $post->post_title,
				'post_content' => $post->post_content,
				'post_excerpt' => $post->post_excerpt,
			),
			$posts
		);
	}

	/** @param array<string,mixed> $scope Parent-site terms scope. @return array<int,array<string,mixed>> */
	private function export_terms( array $scope ): array {
		$args = array(
			'taxonomy'   => ! empty( $scope['taxonomies'] ) && is_array( $scope['taxonomies'] ) ? array_map( 'sanitize_key', $scope['taxonomies'] ) : array( 'category', 'post_tag' ),
			'number'     => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'hide_empty' => false,
			'orderby'    => 'term_id',
			'order'      => 'ASC',
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$args['include'] = array_map( 'absint', $scope['ids'] );
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$args['slug'] = array_map( 'sanitize_title', $scope['slugs'] );
		}
		if ( ! empty( $scope['names'] ) && is_array( $scope['names'] ) ) {
			$args['name'] = array_values( array_map( 'sanitize_text_field', $scope['names'] ) );
		}

		$terms = function_exists( 'get_terms' ) ? get_terms( $args ) : array();
		if ( is_wp_error( $terms ) || ! is_array( $terms ) ) {
			return array();
		}

		return array_map(
			static fn( WP_Term $term ): array => array(
				'id'          => (int) $term->term_id,
				'taxonomy'    => $term->taxonomy,
				'slug'        => $term->slug,
				'name'        => $term->name,
				'description' => $term->description,
			),
			array_slice( $terms, 0, min( 100, max( 1, (int) $scope['maxRecords'] ) ) )
		);
	}

	/** @param array<string,mixed> $scope Parent-site options scope. @return array<string,mixed> */
	private function export_options( array $scope ): array {
		$options = array();
		$names   = ! empty( $scope['names'] ) && is_array( $scope['names'] ) ? array_slice( $scope['names'], 0, min( 100, max( 1, (int) $scope['maxRecords'] ) ) ) : array();
		foreach ( $names as $name ) {
			$name = sanitize_key( (string) $name );
			if ( '' === $name ) {
				continue;
			}
			$options[ $name ] = get_option( $name );
		}

		return $options;
	}

	/** @param array<string,mixed> $scope Parent-site users scope. @return array<int,array<string,mixed>> */
	private function export_users( array $scope ): array {
		$args = array(
			'number'  => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby' => 'ID',
			'order'   => 'ASC',
			'fields'  => array( 'ID', 'display_name', 'roles' ),
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$args['include'] = array_map( 'absint', $scope['ids'] );
		}
		if ( ! empty( $scope['roles'] ) && is_array( $scope['roles'] ) ) {
			$args['role__in'] = array_map( 'sanitize_key', $scope['roles'] );
		}

		$users = function_exists( 'get_users' ) ? get_users( $args ) : array();
		return array_map(
			static fn( WP_User $user ): array => array(
				'id'           => (int) $user->ID,
				'user_login'   => 'seed-user-' . (int) $user->ID,
				'user_email'   => 'seed-user-' . (int) $user->ID . '@example.invalid',
				'display_name' => 'Seed user ' . (int) $user->ID,
				'roles'        => array_values( array_map( 'sanitize_key', (array) $user->roles ) ),
			),
			$users
		);
	}

	/** @param array<string,mixed> $scope Parent-site media scope. @return array<int,array<string,mixed>> */
	private function export_media( array $scope ): array {
		$query = array(
			'post_type'      => 'attachment',
			'post_status'    => ! empty( $scope['statuses'] ) && is_array( $scope['statuses'] ) ? array_map( 'sanitize_key', $scope['statuses'] ) : array( 'inherit' ),
			'posts_per_page' => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby'        => 'ID',
			'order'          => 'ASC',
			'no_found_rows'  => true,
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$query['post__in'] = array_map( 'absint', $scope['ids'] );
			$query['orderby']  = 'post__in';
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$query['post_name__in'] = array_map( 'sanitize_title', $scope['slugs'] );
		}

		$attachments = function_exists( 'get_posts' ) ? get_posts( $query ) : array();
		return array_map(
			static fn( WP_Post $post ): array => array(
				'id'             => (int) $post->ID,
				'post_name'      => $post->post_name,
				'post_title'     => $post->post_title,
				'post_excerpt'   => $post->post_excerpt,
				'post_mime_type' => $post->post_mime_type,
				'post_status'    => $post->post_status,
			),
			$attachments
		);
	}
}
