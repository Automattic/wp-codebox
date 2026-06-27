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

    function wp_codebox_query_recorder_start( $id, $fingerprint_limit = 50, $length_limit = 500 ) {
        if ( ! function_exists( 'add_filter' ) ) {
            return array( 'status' => 'unavailable', 'reason' => 'wordpress_filter_api_unavailable' );
        }
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
            $sql = (string) $query;
            if ( '' === trim( $sql ) ) {
                return $query;
            }
            $fingerprint = wp_codebox_query_recorder_fingerprint( $sql, $length_limit );
            $key = hash( 'sha256', $fingerprint );
            ++$GLOBALS['wp_codebox_query_recorders'][ $id ]['queryCount'];
            if ( ! isset( $GLOBALS['wp_codebox_query_recorders'][ $id ]['fingerprints'][ $key ] ) ) {
                if ( count( $GLOBALS['wp_codebox_query_recorders'][ $id ]['fingerprints'] ) >= $fingerprint_limit ) {
                    $GLOBALS['wp_codebox_query_recorders'][ $id ]['truncated'] = true;
                    return $query;
                }
                $GLOBALS['wp_codebox_query_recorders'][ $id ]['fingerprints'][ $key ] = array( 'fingerprint' => $fingerprint, 'count' => 0, 'totalTimeMs' => 0 );
            }
            ++$GLOBALS['wp_codebox_query_recorders'][ $id ]['fingerprints'][ $key ]['count'];
            return $query;
        };
        $GLOBALS['wp_codebox_query_recorders'][ $id ] = array(
            'queryCount' => 0,
            'totalTimeMs' => 0.0,
            'fingerprints' => array(),
            'truncated' => false,
            'callback' => $callback,
        );
        add_filter( 'query', $callback, PHP_INT_MIN, 1 );
        return array( 'status' => 'captured', 'reason' => null );
    }

    function wp_codebox_query_recorder_report( $id ) {
        $id = (string) $id;
        if ( ! isset( $GLOBALS['wp_codebox_query_recorders'][ $id ] ) || ! is_array( $GLOBALS['wp_codebox_query_recorders'][ $id ] ) ) {
            return array( 'status' => 'unavailable', 'reason' => 'query_recorder_not_started', 'queryCount' => 0, 'totalTimeMs' => 0, 'fingerprints' => array(), 'repeatedQueries' => array() );
        }
        $recorder = $GLOBALS['wp_codebox_query_recorders'][ $id ];
        if ( function_exists( 'remove_filter' ) && isset( $recorder['callback'] ) ) {
            remove_filter( 'query', $recorder['callback'], PHP_INT_MIN );
        }
        unset( $GLOBALS['wp_codebox_query_recorders'][ $id ] );
        $fingerprints = array_values( is_array( $recorder['fingerprints'] ?? null ) ? $recorder['fingerprints'] : array() );
        usort( $fingerprints, static fn( $a, $b ) => ( (int) ( $b['count'] ?? 0 ) <=> (int) ( $a['count'] ?? 0 ) ) ?: strcmp( (string) ( $a['fingerprint'] ?? '' ), (string) ( $b['fingerprint'] ?? '' ) ) );
        $repeated = array_values( array_filter( $fingerprints, static fn( $query ) => isset( $query['count'] ) && $query['count'] > 1 ) );
        return array(
            'status' => 'captured',
            'reason' => ! empty( $recorder['truncated'] ) ? 'query_fingerprint_limit_reached' : null,
            'queryCount' => (int) ( $recorder['queryCount'] ?? 0 ),
            'totalTimeMs' => 0,
            'fingerprints' => $fingerprints,
            'repeatedQueries' => $repeated,
        );
    }
}
`
}
