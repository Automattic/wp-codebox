import { normalizeWordPressCrudOperation, normalizeWordPressDbOperation, type WordPressCrudOperation, type WordPressDbOperation } from "@automattic/wp-codebox-core"
import { argValue } from "./command-args.js"

export function wordpressCrudOperationFromArgs(args: string[]): WordPressCrudOperation {
  const rawOperation = argValue(args, "operation-json")
  if (!rawOperation) {
    throw new Error("wordpress.crud-operation requires operation-json=<wp-codebox/wordpress-crud-operation/v1 JSON object>")
  }
  return normalizeWordPressCrudOperation(JSON.parse(rawOperation))
}

export function wordpressDbOperationFromArgs(args: string[]): WordPressDbOperation {
  const rawOperation = argValue(args, "operation-json")
  if (!rawOperation) {
    throw new Error("wordpress.db-operation requires operation-json=<wp-codebox/wordpress-db-operation/v1 JSON object>")
  }
  return normalizeWordPressDbOperation(JSON.parse(rawOperation))
}

export function wordpressCrudOperationPhpCode(operation: WordPressCrudOperation): string {
  return `$wp_codebox_operation = json_decode( ${JSON.stringify(JSON.stringify(operation))}, true );
wp_codebox_emit_crud_result( $wp_codebox_operation );

function wp_codebox_crud_result( $operation, $status = 'ok', $extra = array() ) {
    return array_merge( array(
        'schema' => 'wp-codebox/wordpress-crud-result/v1',
        'command' => 'wordpress.crud-operation',
        'status' => $status,
        'operation' => $operation,
        'effects' => array(),
        'artifactRefs' => array(),
    ), $extra );
}

function wp_codebox_crud_error( $operation, $code, $message ) {
    return wp_codebox_crud_result( $operation, 'error', array(
        'errors' => array( array( 'code' => $code, 'message' => $message, 'severity' => 'error' ) ),
    ) );
}

function wp_codebox_crud_write_allowed( $operation ) {
    $options = isset( $operation['options'] ) && is_array( $operation['options'] ) ? $operation['options'] : array();
    return ! empty( $options['allowWrites'] ) || ! empty( $options['allow_writes'] );
}

function wp_codebox_crud_is_dry_run( $operation ) {
    $options = isset( $operation['options'] ) && is_array( $operation['options'] ) ? $operation['options'] : array();
    return ! empty( $options['dryRun'] ) || ! empty( $options['dry_run'] );
}

function wp_codebox_crud_require_write_guard( $operation ) {
    if ( wp_codebox_crud_is_dry_run( $operation ) ) {
        return null;
    }
    if ( ! wp_codebox_crud_write_allowed( $operation ) ) {
        return wp_codebox_crud_error( $operation, 'write-guard-required', 'Create, update, and delete operations require options.allowWrites=true. Use options.dryRun=true to preview effects without writing.' );
    }
    return null;
}

function wp_codebox_crud_limit( $operation ) {
    $query = isset( $operation['query'] ) && is_array( $operation['query'] ) ? $operation['query'] : array();
    $limit = isset( $query['limit'] ) ? (int) $query['limit'] : 20;
    return max( 1, min( 100, $limit ) );
}

function wp_codebox_crud_resource_id( $operation ) {
    return isset( $operation['resource']['id'] ) ? $operation['resource']['id'] : null;
}

function wp_codebox_crud_emit_result( $result ) {
    echo wp_json_encode( $result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
}

function wp_codebox_emit_crud_result( $operation ) {
    $verb = (string) $operation['operation'];
    $resource = isset( $operation['resource'] ) && is_array( $operation['resource'] ) ? $operation['resource'] : array();
    $kind = isset( $resource['kind'] ) ? (string) $resource['kind'] : '';
    $data = isset( $operation['data'] ) && is_array( $operation['data'] ) ? $operation['data'] : array();
    $query = isset( $operation['query'] ) && is_array( $operation['query'] ) ? $operation['query'] : array();
    $id = wp_codebox_crud_resource_id( $operation );

    try {
        if ( in_array( $verb, array( 'create', 'update', 'delete' ), true ) ) {
            $guard = wp_codebox_crud_require_write_guard( $operation );
            if ( $guard !== null ) {
                wp_codebox_crud_emit_result( $guard );
                return;
            }
            if ( wp_codebox_crud_is_dry_run( $operation ) ) {
                wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array(
                    'diagnostics' => array( array( 'code' => 'dry-run', 'message' => 'Operation validated but not applied because options.dryRun=true.', 'severity' => 'info' ) ),
                    'effects' => array( array( 'kind' => $verb, 'resource' => $resource, 'metadata' => array( 'dryRun' => true ) ) ),
                ) ) );
                return;
            }
        }

        if ( $kind === 'post' ) {
            if ( $verb === 'read' ) {
                $post = get_post( (int) $id, ARRAY_A );
                wp_codebox_crud_emit_result( $post ? wp_codebox_crud_result( $operation, 'ok', array( 'item' => $post ) ) : wp_codebox_crud_error( $operation, 'not-found', 'Post not found.' ) );
                return;
            }
            if ( $verb === 'list' ) {
                $posts = get_posts( array( 'post_type' => isset( $resource['type'] ) ? $resource['type'] : 'any', 'post_status' => isset( $query['status'] ) ? $query['status'] : 'any', 'numberposts' => wp_codebox_crud_limit( $operation ), 'suppress_filters' => false ) );
                wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'items' => array_map( static function ( $post ) { return $post->to_array(); }, $posts ) ) ) );
                return;
            }
            $post_data = array_merge( $data, $id ? array( 'ID' => (int) $id ) : array() );
            $result_id = $verb === 'create' ? wp_insert_post( $post_data, true ) : ( $verb === 'update' ? wp_update_post( $post_data, true ) : wp_delete_post( (int) $id, ! empty( $query['force'] ) ) );
            if ( is_wp_error( $result_id ) ) throw new RuntimeException( $result_id->get_error_message() );
            wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => $verb === 'delete' ? array( 'deleted' => (bool) $result_id ) : get_post( (int) $result_id, ARRAY_A ), 'effects' => array( array( 'kind' => $verb, 'resource' => $resource ) ) ) ) );
            return;
        }

        if ( $kind === 'term' ) {
            $taxonomy = isset( $resource['type'] ) ? (string) $resource['type'] : ( isset( $data['taxonomy'] ) ? (string) $data['taxonomy'] : 'category' );
            if ( $verb === 'read' ) {
                $term = get_term( (int) $id, $taxonomy, ARRAY_A );
                wp_codebox_crud_emit_result( $term && ! is_wp_error( $term ) ? wp_codebox_crud_result( $operation, 'ok', array( 'item' => $term ) ) : wp_codebox_crud_error( $operation, 'not-found', 'Term not found.' ) );
                return;
            }
            if ( $verb === 'list' ) {
                $terms = get_terms( array( 'taxonomy' => $taxonomy, 'hide_empty' => false, 'number' => wp_codebox_crud_limit( $operation ) ) );
                if ( is_wp_error( $terms ) ) throw new RuntimeException( $terms->get_error_message() );
                wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'items' => array_map( static function ( $term ) { return (array) $term; }, $terms ) ) ) );
                return;
            }
            $result = $verb === 'create' ? wp_insert_term( (string) ( $data['name'] ?? '' ), $taxonomy, $data ) : ( $verb === 'update' ? wp_update_term( (int) $id, $taxonomy, $data ) : wp_delete_term( (int) $id, $taxonomy ) );
            if ( is_wp_error( $result ) ) throw new RuntimeException( $result->get_error_message() );
            wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => $result, 'effects' => array( array( 'kind' => $verb, 'resource' => $resource ) ) ) ) );
            return;
        }

        if ( $kind === 'user' ) {
            if ( $verb === 'read' ) {
                $user = get_user_by( 'id', (int) $id );
                wp_codebox_crud_emit_result( $user ? wp_codebox_crud_result( $operation, 'ok', array( 'item' => $user->to_array() ) ) : wp_codebox_crud_error( $operation, 'not-found', 'User not found.' ) );
                return;
            }
            if ( $verb === 'list' ) {
                $users = get_users( array( 'number' => wp_codebox_crud_limit( $operation ) ) );
                wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'items' => array_map( static function ( $user ) { return $user->to_array(); }, $users ) ) ) );
                return;
            }
            if ( $verb === 'delete' && ! function_exists( 'wp_delete_user' ) ) require_once ABSPATH . 'wp-admin/includes/user.php';
            $result_id = $verb === 'create' ? wp_insert_user( $data ) : ( $verb === 'update' ? wp_update_user( array_merge( $data, array( 'ID' => (int) $id ) ) ) : wp_delete_user( (int) $id ) );
            if ( is_wp_error( $result_id ) ) throw new RuntimeException( $result_id->get_error_message() );
            wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => array( 'id' => $result_id ), 'effects' => array( array( 'kind' => $verb, 'resource' => $resource ) ) ) ) );
            return;
        }

        if ( $kind === 'option' ) {
            $name = (string) ( $resource['id'] ?? $data['name'] ?? '' );
            if ( $name === '' ) throw new RuntimeException( 'Option operations require resource.id or data.name.' );
            if ( $verb === 'read' ) { wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => array( 'name' => $name, 'value' => get_option( $name, null ) ) ) ) ); return; }
            if ( $verb === 'list' ) {
                global $wpdb;
                $like = isset( $query['search'] ) ? '%' . $wpdb->esc_like( (string) $query['search'] ) . '%' : '%';
                $rows = $wpdb->get_results( $wpdb->prepare( "SELECT option_name AS name, option_value AS value, autoload FROM {$wpdb->options} WHERE option_name LIKE %s ORDER BY option_name ASC LIMIT %d", $like, wp_codebox_crud_limit( $operation ) ), ARRAY_A );
                wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'items' => $rows ) ) );
                return;
            }
            $value = array_key_exists( 'value', $data ) ? $data['value'] : null;
            $ok = $verb === 'create' ? add_option( $name, $value ) : ( $verb === 'update' ? update_option( $name, $value ) : delete_option( $name ) );
            wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => array( 'name' => $name, 'changed' => (bool) $ok ), 'effects' => array( array( 'kind' => $verb, 'resource' => $resource ) ) ) ) );
            return;
        }

        if ( $kind === 'metadata' || $kind === 'meta' ) {
            $meta_type = (string) ( $resource['type'] ?? $data['metaType'] ?? $data['meta_type'] ?? 'post' );
            $object_id = (int) ( $resource['id'] ?? $data['objectId'] ?? $data['object_id'] ?? 0 );
            $key = (string) ( $data['key'] ?? $query['key'] ?? '' );
            if ( $object_id <= 0 || $key === '' ) throw new RuntimeException( 'Metadata operations require object id and key.' );
            if ( $verb === 'read' ) { wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => array( 'metaType' => $meta_type, 'objectId' => $object_id, 'key' => $key, 'value' => get_metadata( $meta_type, $object_id, $key, false ) ) ) ) ); return; }
            if ( $verb === 'list' ) { wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'items' => array( get_metadata( $meta_type, $object_id ) ) ) ) ); return; }
            $value = array_key_exists( 'value', $data ) ? $data['value'] : null;
            $ok = $verb === 'create' ? add_metadata( $meta_type, $object_id, $key, $value ) : ( $verb === 'update' ? update_metadata( $meta_type, $object_id, $key, $value ) : delete_metadata( $meta_type, $object_id, $key ) );
            wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => array( 'changed' => (bool) $ok ), 'effects' => array( array( 'kind' => $verb, 'resource' => $resource ) ) ) ) );
            return;
        }

        wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'unsupported', array( 'diagnostics' => array( array( 'code' => 'unsupported-resource', 'message' => 'Unsupported WordPress CRUD resource kind: ' . $kind, 'severity' => 'warning' ) ) ) ) );
    } catch ( Throwable $error ) {
        wp_codebox_crud_emit_result( wp_codebox_crud_error( $operation, 'operation-failed', $error->getMessage() ) );
    }
}`
}

export function wordpressDbOperationPhpCode(operation: WordPressDbOperation): string {
  return `$wp_codebox_operation = json_decode( ${JSON.stringify(JSON.stringify(operation))}, true );
wp_codebox_emit_db_result( $wp_codebox_operation );

function wp_codebox_db_result( $operation, $status = 'ok', $extra = array() ) {
    return array_merge( array(
        'schema' => 'wp-codebox/wordpress-db-result/v1',
        'command' => 'wordpress.db-operation',
        'status' => $status,
        'operation' => $operation,
        'artifactRefs' => array(),
    ), $extra );
}

function wp_codebox_db_error( $operation, $code, $message ) {
    return wp_codebox_db_result( $operation, 'error', array( 'errors' => array( array( 'code' => $code, 'message' => $message, 'severity' => 'error' ) ) ) );
}

function wp_codebox_db_emit_result( $result ) {
    echo wp_json_encode( $result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
}

function wp_codebox_db_limit( $operation ) {
    $query = isset( $operation['query'] ) && is_array( $operation['query'] ) ? $operation['query'] : array();
    $limit = isset( $query['limit'] ) ? (int) $query['limit'] : 20;
    return max( 1, min( 100, $limit ) );
}

function wp_codebox_db_table_name( $operation ) {
    global $wpdb;
    $resource = isset( $operation['resource'] ) && is_array( $operation['resource'] ) ? $operation['resource'] : array();
    $query = isset( $operation['query'] ) && is_array( $operation['query'] ) ? $operation['query'] : array();
    $base = isset( $resource['table'] ) ? (string) $resource['table'] : ( isset( $query['table'] ) ? (string) $query['table'] : '' );
    $base = preg_replace( '/[^A-Za-z0-9_]/', '', $base );
    if ( $base === '' ) {
        return null;
    }
    $known = array( 'posts', 'postmeta', 'terms', 'term_taxonomy', 'term_relationships', 'termmeta', 'users', 'usermeta', 'options', 'comments', 'commentmeta', 'links' );
    if ( ! in_array( $base, $known, true ) ) {
        return null;
    }
    return isset( $wpdb->{$base} ) ? $wpdb->{$base} : $wpdb->prefix . $base;
}

function wp_codebox_db_select_columns( $columns ) {
    if ( ! is_array( $columns ) || count( $columns ) === 0 ) {
        return '*';
    }
    $safe = array();
    foreach ( $columns as $column ) {
        $column = preg_replace( '/[^A-Za-z0-9_]/', '', (string) $column );
        if ( $column !== '' ) {
            $safe[] = $column;
        }
    }
    return count( $safe ) > 0 ? implode( ', ', $safe ) : '*';
}

function wp_codebox_emit_db_result( $operation ) {
    global $wpdb;
    $verb = (string) $operation['operation'];
    $query = isset( $operation['query'] ) && is_array( $operation['query'] ) ? $operation['query'] : array();

    try {
        if ( $verb === 'write' ) {
            wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'db-write-unsupported', 'Generic DB writes are intentionally unsupported. Use WordPress CRUD resources with options.allowWrites=true for bounded writes.' ) );
            return;
        }

        if ( $verb === 'schema' ) {
            $tables = array();
            $requested = wp_codebox_db_table_name( $operation );
            $table_names = $requested ? array( $requested ) : $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $wpdb->prefix ) . '%' ) );
            foreach ( $table_names as $table ) {
                $columns = $wpdb->get_results( 'DESCRIBE ' . $table, ARRAY_A );
                $tables[] = array( 'name' => $table, 'columns' => $columns );
            }
            wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'items' => $tables, 'metadata' => array( 'tableCount' => count( $tables ) ) ) ) );
            return;
        }

        if ( $verb === 'query-summary' ) {
            $sql = isset( $query['sql'] ) ? trim( (string) $query['sql'] ) : '';
            if ( $sql === '' ) {
                wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'item' => array( 'queryCount' => is_array( $wpdb->queries ) ? count( $wpdb->queries ) : null ) ) ) );
                return;
            }
            if ( ! preg_match( '/^(SELECT|SHOW|DESCRIBE|EXPLAIN)\\b/i', $sql ) ) {
                wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'unsafe-query', 'query-summary only accepts SELECT, SHOW, DESCRIBE, or EXPLAIN SQL.' ) );
                return;
            }
            $rows = $wpdb->get_results( $sql, ARRAY_A );
            wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'items' => array_slice( is_array( $rows ) ? $rows : array(), 0, wp_codebox_db_limit( $operation ) ), 'metadata' => array( 'rowCount' => is_array( $rows ) ? count( $rows ) : 0, 'truncated' => is_array( $rows ) && count( $rows ) > wp_codebox_db_limit( $operation ) ) ) ) );
            return;
        }

        if ( $verb === 'read' ) {
            $table = wp_codebox_db_table_name( $operation );
            if ( ! $table ) {
                wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'unsafe-table', 'DB reads require a known WordPress table base name such as posts, postmeta, options, terms, termmeta, users, or usermeta.' ) );
                return;
            }
            $columns = wp_codebox_db_select_columns( isset( $query['columns'] ) ? $query['columns'] : array() );
            $where = isset( $query['where'] ) && is_array( $query['where'] ) ? $query['where'] : array();
            $clauses = array();
            $values = array();
            foreach ( $where as $column => $value ) {
                if ( is_array( $value ) || is_object( $value ) ) {
                    continue;
                }
                $column = preg_replace( '/[^A-Za-z0-9_]/', '', (string) $column );
                if ( $column !== '' ) {
                    $clauses[] = $column . ' = %s';
                    $values[] = (string) $value;
                }
            }
            $sql = 'SELECT ' . $columns . ' FROM ' . $table . ( count( $clauses ) ? ' WHERE ' . implode( ' AND ', $clauses ) : '' ) . ' LIMIT %d';
            $values[] = wp_codebox_db_limit( $operation );
            $rows = $wpdb->get_results( $wpdb->prepare( $sql, $values ), ARRAY_A );
            wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'items' => is_array( $rows ) ? $rows : array() ) ) );
            return;
        }

        wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'unsupported', array( 'diagnostics' => array( array( 'code' => 'unsupported-db-operation', 'message' => 'Unsupported DB operation.', 'severity' => 'warning' ) ) ) ) );
    } catch ( Throwable $error ) {
        wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'operation-failed', $error->getMessage() ) );
    }
}`
}
