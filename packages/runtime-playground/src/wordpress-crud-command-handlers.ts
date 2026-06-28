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

        if ( $kind === 'comment' ) {
            if ( $verb === 'read' ) {
                $comment = get_comment( (int) $id, ARRAY_A );
                wp_codebox_crud_emit_result( $comment ? wp_codebox_crud_result( $operation, 'ok', array( 'item' => $comment ) ) : wp_codebox_crud_error( $operation, 'not-found', 'Comment not found.' ) );
                return;
            }
            if ( $verb === 'list' ) {
                $comments = get_comments( array_merge( $query, array( 'number' => wp_codebox_crud_limit( $operation ) ) ) );
                wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'items' => array_map( static function ( $comment ) { return $comment->to_array(); }, $comments ) ) ) );
                return;
            }
            $comment_data = array_merge( $data, $id ? array( 'comment_ID' => (int) $id ) : array() );
            $result_id = $verb === 'create' ? wp_insert_comment( $comment_data ) : ( $verb === 'update' ? wp_update_comment( $comment_data ) : wp_delete_comment( (int) $id, ! empty( $query['force'] ) ) );
            if ( ! $result_id ) throw new RuntimeException( 'Comment operation failed.' );
            $comment_id = $verb === 'create' ? (int) $result_id : (int) $id;
            wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => $verb === 'delete' ? array( 'deleted' => (bool) $result_id ) : get_comment( $comment_id, ARRAY_A ), 'effects' => array( array( 'kind' => $verb, 'resource' => $resource ) ) ) ) );
            return;
        }

        if ( $kind === 'attachment' || $kind === 'media' ) {
            if ( $verb === 'read' ) {
                $attachment = get_post( (int) $id, ARRAY_A );
                wp_codebox_crud_emit_result( $attachment && $attachment['post_type'] === 'attachment' ? wp_codebox_crud_result( $operation, 'ok', array( 'item' => $attachment ) ) : wp_codebox_crud_error( $operation, 'not-found', 'Attachment not found.' ) );
                return;
            }
            if ( $verb === 'list' ) {
                $attachments = get_posts( array( 'post_type' => 'attachment', 'post_status' => isset( $query['status'] ) ? $query['status'] : 'any', 'numberposts' => wp_codebox_crud_limit( $operation ), 'suppress_filters' => false ) );
                wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'items' => array_map( static function ( $attachment ) { return $attachment->to_array(); }, $attachments ) ) ) );
                return;
            }
            $attachment_data = array_merge( $data, array( 'post_type' => 'attachment' ), $id ? array( 'ID' => (int) $id ) : array() );
            $file = isset( $data['file'] ) ? (string) $data['file'] : false;
            $parent_post_id = isset( $data['post_parent'] ) ? (int) $data['post_parent'] : 0;
            $result_id = $verb === 'create' ? wp_insert_attachment( $attachment_data, $file, $parent_post_id, true ) : ( $verb === 'update' ? wp_update_post( $attachment_data, true ) : wp_delete_attachment( (int) $id, ! empty( $query['force'] ) ) );
            if ( is_wp_error( $result_id ) ) throw new RuntimeException( $result_id->get_error_message() );
            wp_codebox_crud_emit_result( wp_codebox_crud_result( $operation, 'ok', array( 'item' => $verb === 'delete' ? array( 'deleted' => (bool) $result_id ) : get_post( (int) $result_id, ARRAY_A ), 'effects' => array( array( 'kind' => $verb, 'resource' => $resource ) ) ) ) );
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

function wp_codebox_db_write_allowed( $operation ) {
    $options = isset( $operation['options'] ) && is_array( $operation['options'] ) ? $operation['options'] : array();
    return ! empty( $options['allowWrites'] ) || ! empty( $options['allow_writes'] );
}

function wp_codebox_db_write_bounded( $operation ) {
    $options = isset( $operation['options'] ) && is_array( $operation['options'] ) ? $operation['options'] : array();
    return ! empty( $options['bounded'] );
}

function wp_codebox_db_write_mutation( $operation ) {
    $options = isset( $operation['options'] ) && is_array( $operation['options'] ) ? $operation['options'] : array();
    $mutation = isset( $options['mutation'] ) ? strtolower( (string) $options['mutation'] ) : 'update';
    return in_array( $mutation, array( 'insert', 'update', 'delete' ), true ) ? $mutation : 'update';
}

function wp_codebox_db_quote_identifier( $identifier ) {
    return '\`' . str_replace( '\`', '\`\`', (string) $identifier ) . '\`';
}

function wp_codebox_db_discovered_tables() {
    global $wpdb;
    $core = array();
    foreach ( array_values( array_unique( array_map( 'strval', $wpdb->tables( 'all' ) ) ) ) as $base_name ) {
        $core[ $wpdb->prefix . $base_name ] = $base_name;
    }
    $tables = array();
    foreach ( (array) $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $wpdb->prefix ) . '%' ) ) as $name ) {
        $name = (string) $name;
        $base_name = isset( $core[ $name ] ) ? $core[ $name ] : ( str_starts_with( $name, $wpdb->prefix ) ? substr( $name, strlen( $wpdb->prefix ) ) : $name );
        $table = array( 'name' => $name, 'baseName' => $base_name, 'classification' => isset( $core[ $name ] ) ? 'core' : ( str_starts_with( $name, $wpdb->prefix ) ? 'prefixed' : 'external' ) );
        $tables[ $name ] = $table;
        $tables[ $base_name ] = $table;
    }
    return $tables;
}

function wp_codebox_db_resolve_table( $operation ) {
    global $wpdb;
    $resource = isset( $operation['resource'] ) && is_array( $operation['resource'] ) ? $operation['resource'] : array();
    $query = isset( $operation['query'] ) && is_array( $operation['query'] ) ? $operation['query'] : array();
    $base = isset( $resource['table'] ) ? (string) $resource['table'] : ( isset( $query['table'] ) ? (string) $query['table'] : '' );
    $base = preg_replace( '/[^A-Za-z0-9_]/', '', $base );
    if ( $base === '' ) {
        return null;
    }
    $tables = wp_codebox_db_discovered_tables();
    return isset( $tables[ $base ] ) ? $tables[ $base ] : ( isset( $tables[ $wpdb->prefix . $base ] ) ? $tables[ $wpdb->prefix . $base ] : null );
}

function wp_codebox_db_table_columns( $table ) {
    global $wpdb;
    $columns = array();
    foreach ( (array) $wpdb->get_results( 'DESCRIBE ' . wp_codebox_db_quote_identifier( $table ), ARRAY_A ) as $column ) {
        $name = (string) ( $column['Field'] ?? '' );
        if ( $name !== '' ) {
            $columns[ $name ] = array( 'name' => $name, 'type' => (string) ( $column['Type'] ?? '' ), 'nullable' => strtoupper( (string) ( $column['Null'] ?? '' ) ) === 'YES', 'key' => (string) ( $column['Key'] ?? '' ), 'default' => array_key_exists( 'Default', $column ) && $column['Default'] !== null ? (string) $column['Default'] : null, 'extra' => (string) ( $column['Extra'] ?? '' ) );
        }
    }
    return $columns;
}

function wp_codebox_db_select_columns( $columns, $allowed_columns ) {
    if ( ! is_array( $columns ) || count( $columns ) === 0 ) {
        return array( 'sql' => '*', 'columns' => array_keys( $allowed_columns ) );
    }
    $safe = array();
    foreach ( $columns as $column ) {
        $column = preg_replace( '/[^A-Za-z0-9_]/', '', (string) $column );
        if ( $column !== '' && isset( $allowed_columns[ $column ] ) ) {
            $safe[] = $column;
        }
    }
    return count( $safe ) > 0 ? array( 'sql' => implode( ', ', array_map( 'wp_codebox_db_quote_identifier', $safe ) ), 'columns' => $safe ) : null;
}

function wp_codebox_db_safe_values( $values, $allowed_columns ) {
    if ( ! is_array( $values ) ) {
        return array();
    }
    $safe = array();
    foreach ( $values as $column => $value ) {
        $column = preg_replace( '/[^A-Za-z0-9_]/', '', (string) $column );
        if ( $column !== '' && isset( $allowed_columns[ $column ] ) && ( is_scalar( $value ) || $value === null ) ) {
            $safe[ $column ] = $value;
        }
    }
    return $safe;
}

function wp_codebox_emit_db_result( $operation ) {
    global $wpdb;
    $verb = (string) $operation['operation'];
    $query = isset( $operation['query'] ) && is_array( $operation['query'] ) ? $operation['query'] : array();

    try {
        if ( $verb === 'write' ) {
            if ( ! wp_codebox_db_write_allowed( $operation ) || ! wp_codebox_db_write_bounded( $operation ) ) {
                wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'db-write-guard-required', 'DB writes require options.allowWrites=true and options.bounded=true.' ) );
                return;
            }
            $table = wp_codebox_db_resolve_table( $operation );
            if ( ! $table ) {
                wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'unsafe-table', 'DB writes require a discovered prefixed WordPress table name or base name.' ) );
                return;
            }
            $allowed_columns = wp_codebox_db_table_columns( $table['name'] );
            $mutation = wp_codebox_db_write_mutation( $operation );
            $values = wp_codebox_db_safe_values( isset( $query['values'] ) ? $query['values'] : array(), $allowed_columns );
            $where = wp_codebox_db_safe_values( isset( $query['where'] ) ? $query['where'] : array(), $allowed_columns );
            $affected = 0;
            $diagnostics = array( array( 'code' => 'reset-isolated-db-mutation', 'message' => 'DB mutation executed through reset-isolated fuzz runtime; affected rows may be zero or unknown.', 'severity' => 'info' ) );
            if ( $mutation === 'insert' && count( $values ) > 0 ) {
                $result = $wpdb->insert( $table['name'], $values );
                $affected = $result === false ? null : (int) $wpdb->rows_affected;
            } elseif ( $mutation === 'update' && count( $values ) > 0 && count( $where ) > 0 ) {
                $result = $wpdb->update( $table['name'], $values, $where );
                $affected = $result === false ? null : (int) $wpdb->rows_affected;
            } elseif ( $mutation === 'delete' && count( $where ) > 0 ) {
                $result = $wpdb->delete( $table['name'], $where );
                $affected = $result === false ? null : (int) $wpdb->rows_affected;
            } else {
                $diagnostics[] = array( 'code' => 'db-mutation-no-op', 'message' => 'Mutation candidate had insufficient bounded values/filters; recorded as a zero-row runtime observation.', 'severity' => 'info' );
            }
            wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'diagnostics' => $diagnostics, 'metadata' => array( 'table' => $table, 'mutation' => $mutation, 'affectedRows' => $affected, 'affectedRowsMayBeZeroOrUnknown' => true, 'attribution' => array( 'command' => 'wordpress.db-operation', 'operation' => 'write', 'table' => $table['name'] ) ) ) ) );
            return;
        }

        if ( $verb === 'schema' ) {
            $tables = array();
            $requested = wp_codebox_db_resolve_table( $operation );
            $table_names = $requested ? array( $requested ) : array_values( array_filter( wp_codebox_db_discovered_tables(), static function ( $table, $key ) { return $table['name'] === $key; }, ARRAY_FILTER_USE_BOTH ) );
            foreach ( $table_names as $table ) {
                $columns = array_values( wp_codebox_db_table_columns( $table['name'] ) );
                $indexes = array();
                foreach ( (array) $wpdb->get_results( 'SHOW INDEX FROM ' . wp_codebox_db_quote_identifier( $table['name'] ), ARRAY_A ) as $index ) {
                    $indexes[] = array( 'name' => (string) ( $index['Key_name'] ?? '' ), 'column' => (string) ( $index['Column_name'] ?? '' ), 'unique' => isset( $index['Non_unique'] ) ? ( (int) $index['Non_unique'] === 0 ) : false, 'sequence' => isset( $index['Seq_in_index'] ) ? (int) $index['Seq_in_index'] : null );
                }
                $status_rows = $wpdb->get_results( $wpdb->prepare( 'SHOW TABLE STATUS LIKE %s', $table['name'] ), ARRAY_A );
                $status = is_array( $status_rows ) && isset( $status_rows[0] ) ? array( 'engine' => isset( $status_rows[0]['Engine'] ) ? (string) $status_rows[0]['Engine'] : '', 'rows' => isset( $status_rows[0]['Rows']) ? (int) $status_rows[0]['Rows'] : null, 'collation' => isset( $status_rows[0]['Collation'] ) ? (string) $status_rows[0]['Collation'] : '' ) : null;
                $tables[] = array( 'name' => $table['name'], 'baseName' => $table['baseName'], 'classification' => $table['classification'], 'columns' => $columns, 'indexes' => $indexes, 'status' => $status );
            }
            wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'items' => $tables, 'metadata' => array( 'tableCount' => count( $tables ), 'attribution' => array( 'command' => 'wordpress.db-operation', 'operation' => 'schema' ) ) ) ) );
            return;
        }

        if ( $verb === 'inspect' ) {
            $requested = wp_codebox_db_resolve_table( $operation );
            if ( isset( $operation['resource']['table'] ) && ! $requested ) {
                wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'unsafe-table', 'DB inspection requires a discovered prefixed WordPress table name or base name.' ) );
                return;
            }

            $table_infos = array();
            if ( $requested ) {
                $table_infos[] = $requested;
            } else {
                $table_infos = array_values( array_filter( wp_codebox_db_discovered_tables(), static function ( $table, $key ) { return $table['name'] === $key; }, ARRAY_FILTER_USE_BOTH ) );
            }

            $tables = array();
            foreach ( $table_infos as $table ) {
                $quoted = wp_codebox_db_quote_identifier( $table['name'] );
                $row_count = $wpdb->get_var( 'SELECT COUNT(*) FROM ' . $quoted );
                $indexes = $wpdb->get_results( 'SHOW INDEX FROM ' . $quoted, ARRAY_A );
                $tables[] = array(
                    'name' => $table['name'],
                    'baseName' => $table['baseName'],
                    'classification' => $table['classification'],
                    'rowCount' => $row_count === null ? null : (int) $row_count,
                    'indexes' => is_array( $indexes ) ? $indexes : array(),
                );
            }

            wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'items' => $tables, 'metadata' => array( 'tableCount' => count( $tables ), 'attribution' => array( 'command' => 'wordpress.db-operation', 'operation' => 'inspect' ) ) ) ) );
            return;
        }

        if ( $verb === 'query-summary' ) {
            $sql = isset( $query['sql'] ) ? trim( (string) $query['sql'] ) : '';
            if ( $sql === '' ) {
                wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'item' => array( 'queryCount' => is_array( $wpdb->queries ) ? count( $wpdb->queries ) : null ), 'metadata' => array( 'attribution' => array( 'command' => 'wordpress.db-operation', 'operation' => 'query-summary' ) ) ) ) );
                return;
            }
            if ( ! preg_match( '/^(SELECT|SHOW|DESCRIBE|EXPLAIN)\\b/i', $sql ) ) {
                wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'unsafe-query', 'query-summary only accepts SELECT, SHOW, DESCRIBE, or EXPLAIN SQL.' ) );
                return;
            }
            $rows = $wpdb->get_results( $sql, ARRAY_A );
            wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'items' => array_slice( is_array( $rows ) ? $rows : array(), 0, wp_codebox_db_limit( $operation ) ), 'metadata' => array( 'rowCount' => is_array( $rows ) ? count( $rows ) : 0, 'truncated' => is_array( $rows ) && count( $rows ) > wp_codebox_db_limit( $operation ), 'attribution' => array( 'command' => 'wordpress.db-operation', 'operation' => 'query-summary' ) ) ) ) );
            return;
        }

        if ( $verb === 'read' ) {
            $table = wp_codebox_db_resolve_table( $operation );
            if ( ! $table ) {
                wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'unsafe-table', 'DB reads require a discovered prefixed WordPress table name or base name.' ) );
                return;
            }
            $allowed_columns = wp_codebox_db_table_columns( $table['name'] );
            $columns = wp_codebox_db_select_columns( isset( $query['columns'] ) ? $query['columns'] : array(), $allowed_columns );
            if ( $columns === null ) {
                wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'unsafe-column', 'DB reads require selected columns to exist in the discovered table schema.' ) );
                return;
            }
            $where = isset( $query['where'] ) && is_array( $query['where'] ) ? $query['where'] : array();
            $clauses = array();
            $values = array();
            foreach ( $where as $column => $value ) {
                if ( is_array( $value ) || is_object( $value ) ) {
                    continue;
                }
                $column = preg_replace( '/[^A-Za-z0-9_]/', '', (string) $column );
                if ( $column !== '' && isset( $allowed_columns[ $column ] ) ) {
                    $clauses[] = wp_codebox_db_quote_identifier( $column ) . ' = %s';
                    $values[] = (string) $value;
                } elseif ( $column !== '' ) {
                    wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'unsafe-column', 'DB reads require filter columns to exist in the discovered table schema.' ) );
                    return;
                }
            }
            $sql = 'SELECT ' . $columns['sql'] . ' FROM ' . wp_codebox_db_quote_identifier( $table['name'] ) . ( count( $clauses ) ? ' WHERE ' . implode( ' AND ', $clauses ) : '' ) . ' LIMIT %d';
            $values[] = wp_codebox_db_limit( $operation );
            $rows = $wpdb->get_results( $wpdb->prepare( $sql, $values ), ARRAY_A );
            wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'ok', array( 'items' => is_array( $rows ) ? $rows : array(), 'metadata' => array( 'table' => $table, 'columns' => $columns['columns'], 'limit' => wp_codebox_db_limit( $operation ), 'attribution' => array( 'command' => 'wordpress.db-operation', 'operation' => 'read', 'table' => $table['name'] ) ) ) ) );
            return;
        }

        wp_codebox_db_emit_result( wp_codebox_db_result( $operation, 'unsupported', array( 'diagnostics' => array( array( 'code' => 'unsupported-db-operation', 'message' => 'Unsupported DB operation.', 'severity' => 'warning' ) ) ) ) );
    } catch ( Throwable $error ) {
        wp_codebox_db_emit_result( wp_codebox_db_error( $operation, 'operation-failed', $error->getMessage() ) );
    }
}`
}
