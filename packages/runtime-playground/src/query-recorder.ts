export function wordpressQueryRecorderPhp(): string {
  return `if ( ! function_exists( 'wp_codebox_query_recorder_start' ) ) {
    function wp_codebox_query_recorder_fingerprint( $sql, $length_limit ) {
        $fingerprint = preg_replace( '#/\\*.*?\\*/#s', '/* ? */', (string) $sql );
        $fingerprint = preg_replace( "/'(?:''|[^'])*'/", "'?'", is_string( $fingerprint ) ? $fingerprint : (string) $sql );
        $fingerprint = preg_replace( '/\"(?:\"\"|[^\"])*\"/', '\"?\"', is_string( $fingerprint ) ? $fingerprint : (string) $sql );
        $fingerprint = preg_replace( '/\\b[-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?\\b/i', '?', is_string( $fingerprint ) ? $fingerprint : (string) $sql );
        $fingerprint = strtolower( trim( (string) preg_replace( '/\\s+/', ' ', is_string( $fingerprint ) ? $fingerprint : (string) $sql ) ) );
        return substr( $fingerprint, 0, max( 1, (int) $length_limit ) );
    }

    function wp_codebox_query_recorder_add_record( &$recorder, $sql, $elapsed_ms, $caller = null ) {
        $sql = (string) $sql;
        if ( '' === trim( $sql ) ) {
            return;
        }
        $fingerprint = wp_codebox_query_recorder_fingerprint( $sql, (int) ( $recorder['lengthLimit'] ?? 500 ) );
        $key = hash( 'sha256', $fingerprint );
        ++$recorder['queryCount'];
        if ( ! isset( $recorder['fingerprints'][ $key ] ) ) {
            if ( count( $recorder['fingerprints'] ) >= (int) ( $recorder['fingerprintLimit'] ?? 50 ) ) {
                $recorder['truncated'] = true;
                return;
            }
            $recorder['fingerprints'][ $key ] = array_filter( array( 'fingerprint' => $fingerprint, 'count' => 0, 'sampleMs' => null, 'totalTimeMs' => null, 'caller' => is_string( $caller ) ? substr( $caller, 0, 240 ) : null ), static fn( $value ) => null !== $value );
        }
        ++$recorder['fingerprints'][ $key ]['count'];
        if ( null !== $elapsed_ms ) {
            $elapsed_ms = round( max( 0, (float) $elapsed_ms ), 3 );
            $recorder['totalTimeMs'] = round( (float) ( $recorder['totalTimeMs'] ?? 0 ) + $elapsed_ms, 3 );
            $recorder['fingerprints'][ $key ]['sampleMs'] = $recorder['fingerprints'][ $key ]['sampleMs'] ?? $elapsed_ms;
            $recorder['fingerprints'][ $key ]['totalTimeMs'] = round( (float) ( $recorder['fingerprints'][ $key ]['totalTimeMs'] ?? 0 ) + $elapsed_ms, 3 );
        }
        if ( is_string( $caller ) && '' !== $caller && empty( $recorder['fingerprints'][ $key ]['caller'] ) ) {
            $recorder['fingerprints'][ $key ]['caller'] = substr( $caller, 0, 240 );
        }
    }

    function wp_codebox_query_recorder_start( $id, $fingerprint_limit = 50, $length_limit = 500 ) {
        if ( ! function_exists( 'add_filter' ) ) {
            return array( 'status' => 'unavailable', 'reason' => 'wordpress_filter_api_unavailable' );
        }
        global $wpdb;
        if ( ! isset( $GLOBALS['wp_codebox_query_recorders'] ) || ! is_array( $GLOBALS['wp_codebox_query_recorders'] ) ) {
            $GLOBALS['wp_codebox_query_recorders'] = array();
        }
        $id = (string) $id;
        $fingerprint_limit = max( 0, (int) $fingerprint_limit );
        $length_limit = max( 1, (int) $length_limit );
        $callback = static function ( $query ) use ( $id, $fingerprint_limit, $length_limit ) {
            if ( ! isset( $GLOBALS['wp_codebox_query_recorders'][ $id ] ) || ! is_array( $GLOBALS['wp_codebox_query_recorders'][ $id ] ) ) {
                return $query;
            }
            if ( ! $GLOBALS['wp_codebox_query_recorders'][ $id ]['timingSupported'] ) {
                wp_codebox_query_recorder_add_record( $GLOBALS['wp_codebox_query_recorders'][ $id ], $query, null );
            }
            return $query;
        };
        $timing_supported = is_object( $wpdb ?? null ) && property_exists( $wpdb, 'save_queries' );
        $previous_save_queries = null;
        $query_start = null;
        if ( $timing_supported ) {
            $previous_save_queries = $wpdb->save_queries;
            $wpdb->save_queries = true;
            $query_start = isset( $wpdb->queries ) && is_array( $wpdb->queries ) ? count( $wpdb->queries ) : 0;
        }
        $GLOBALS['wp_codebox_query_recorders'][ $id ] = array(
            'queryCount' => 0,
            'totalTimeMs' => $timing_supported ? 0.0 : null,
            'fingerprints' => array(),
            'truncated' => false,
            'fingerprintLimit' => $fingerprint_limit,
            'lengthLimit' => $length_limit,
            'timingSupported' => $timing_supported,
            'timingReason' => $timing_supported ? null : 'wpdb_save_queries_unavailable',
            'queryStart' => $query_start,
            'previousSaveQueries' => $previous_save_queries,
            'callback' => $callback,
        );
        add_filter( 'query', $callback, PHP_INT_MIN, 1 );
        return array( 'status' => 'captured', 'reason' => null, 'timingStatus' => $timing_supported ? 'captured' : 'unavailable', 'timingReason' => $timing_supported ? null : 'wpdb_save_queries_unavailable' );
    }

    function wp_codebox_query_recorder_report( $id ) {
        global $wpdb;
        $id = (string) $id;
        if ( ! isset( $GLOBALS['wp_codebox_query_recorders'][ $id ] ) || ! is_array( $GLOBALS['wp_codebox_query_recorders'][ $id ] ) ) {
            return array( 'status' => 'unavailable', 'reason' => 'query_recorder_not_started', 'queryCount' => 0, 'totalTimeMs' => null, 'timingStatus' => 'unavailable', 'timingReason' => 'query_recorder_not_started', 'fingerprints' => array(), 'repeatedQueries' => array() );
        }
        $recorder = $GLOBALS['wp_codebox_query_recorders'][ $id ];
        if ( function_exists( 'remove_filter' ) && isset( $recorder['callback'] ) ) {
            remove_filter( 'query', $recorder['callback'], PHP_INT_MIN );
        }
        unset( $GLOBALS['wp_codebox_query_recorders'][ $id ] );
        if ( ! empty( $recorder['timingSupported'] ) && is_object( $wpdb ?? null ) ) {
            $queries = isset( $wpdb->queries ) && is_array( $wpdb->queries ) ? array_slice( $wpdb->queries, max( 0, (int) ( $recorder['queryStart'] ?? 0 ) ) ) : array();
            $recorder['queryCount'] = 0;
            $recorder['totalTimeMs'] = 0.0;
            $recorder['fingerprints'] = array();
            foreach ( $queries as $query ) {
                $sql = is_array( $query ) && isset( $query[0] ) ? (string) $query[0] : '';
                $elapsed_ms = is_array( $query ) && isset( $query[1] ) ? ( (float) $query[1] ) * 1000 : null;
                $caller = is_array( $query ) && isset( $query[2] ) ? (string) $query[2] : null;
                wp_codebox_query_recorder_add_record( $recorder, $sql, $elapsed_ms, $caller );
            }
            if ( property_exists( $wpdb, 'save_queries' ) ) {
                $wpdb->save_queries = $recorder['previousSaveQueries'];
            }
        }
        $fingerprints = array_values( is_array( $recorder['fingerprints'] ?? null ) ? $recorder['fingerprints'] : array() );
        usort( $fingerprints, static fn( $a, $b ) => ( (float) ( $b['totalTimeMs'] ?? -1 ) <=> (float) ( $a['totalTimeMs'] ?? -1 ) ) ?: ( (int) ( $b['count'] ?? 0 ) <=> (int) ( $a['count'] ?? 0 ) ) ?: strcmp( (string) ( $a['fingerprint'] ?? '' ), (string) ( $b['fingerprint'] ?? '' ) ) );
        $repeated = array_values( array_filter( $fingerprints, static fn( $query ) => isset( $query['count'] ) && $query['count'] > 1 ) );
        return array(
            'status' => 'captured',
            'reason' => ! empty( $recorder['truncated'] ) ? 'query_fingerprint_limit_reached' : null,
            'queryCount' => (int) ( $recorder['queryCount'] ?? 0 ),
            'totalTimeMs' => $recorder['totalTimeMs'] ?? null,
            'timingStatus' => ! empty( $recorder['timingSupported'] ) ? 'captured' : 'unavailable',
            'timingReason' => ! empty( $recorder['timingSupported'] ) ? null : ( $recorder['timingReason'] ?? 'wpdb_save_queries_unavailable' ),
            'fingerprints' => $fingerprints,
            'repeatedQueries' => $repeated,
        );
    }
}
`
}
