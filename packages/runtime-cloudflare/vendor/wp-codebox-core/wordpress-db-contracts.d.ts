import type { BackendNeutralArtifactRef } from "./runtime-neutral-contracts.js";
export declare const WORDPRESS_DB_OPERATION_SCHEMA: "wp-codebox/wordpress-db-operation/v1";
export declare const WORDPRESS_DB_RESULT_SCHEMA: "wp-codebox/wordpress-db-result/v1";
export type WordPressDbVerb = "schema" | "read" | "inspect" | "query-summary" | "write";
export type WordPressDbResultStatus = "ok" | "unsupported" | "error";
export interface WordPressDbResourceRef {
    table?: string;
    identifiers?: Record<string, string | number | boolean | null>;
}
export interface WordPressDbOperation {
    schema: typeof WORDPRESS_DB_OPERATION_SCHEMA;
    operation: WordPressDbVerb;
    resource?: WordPressDbResourceRef;
    query?: WordPressDbQuery;
    options?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface WordPressDbQuery {
    table?: string;
    columns?: string[];
    where?: Record<string, string | number | boolean | null>;
    limit?: number;
    sql?: string;
    [key: string]: unknown;
}
export interface WordPressDbDiagnostic {
    code: string;
    message: string;
    severity?: "info" | "warning" | "error";
    metadata?: Record<string, unknown>;
}
export interface WordPressDbResult {
    schema: typeof WORDPRESS_DB_RESULT_SCHEMA;
    command: "wordpress.db-operation";
    status: WordPressDbResultStatus;
    operation: WordPressDbOperation;
    item?: unknown;
    items?: unknown[];
    diagnostics?: WordPressDbDiagnostic[];
    errors?: WordPressDbDiagnostic[];
    artifactRefs?: BackendNeutralArtifactRef[];
    metadata?: Record<string, unknown>;
}
export declare const WORDPRESS_DB_OPERATION_JSON_SCHEMA: {
    readonly $id: "wp-codebox/wordpress-db-operation/v1";
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["schema", "operation"];
    readonly properties: {
        readonly schema: {
            readonly const: "wp-codebox/wordpress-db-operation/v1";
        };
        readonly operation: {
            readonly enum: readonly ["schema", "read", "inspect", "query-summary", "write"];
        };
        readonly resource: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly table: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly identifiers: {
                    readonly type: "object";
                    readonly additionalProperties: {
                        readonly type: readonly ["string", "number", "boolean", "null"];
                    };
                };
            };
        };
        readonly query: {
            readonly type: "object";
            readonly additionalProperties: true;
            readonly properties: {
                readonly table: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly columns: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                };
                readonly where: {
                    readonly type: "object";
                    readonly additionalProperties: {
                        readonly type: readonly ["string", "number", "boolean", "null"];
                    };
                };
                readonly limit: {
                    readonly type: "integer";
                    readonly minimum: 1;
                    readonly maximum: 100;
                };
                readonly sql: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
        };
        readonly options: {
            readonly type: "object";
            readonly additionalProperties: true;
        };
        readonly metadata: {
            readonly type: "object";
            readonly additionalProperties: true;
        };
    };
};
export declare const WORDPRESS_DB_RESULT_JSON_SCHEMA: {
    readonly $id: "wp-codebox/wordpress-db-result/v1";
    readonly type: "object";
    readonly additionalProperties: true;
    readonly required: readonly ["schema", "command", "status", "operation"];
    readonly properties: {
        readonly schema: {
            readonly const: "wp-codebox/wordpress-db-result/v1";
        };
        readonly command: {
            readonly const: "wordpress.db-operation";
        };
        readonly status: {
            readonly enum: readonly ["ok", "unsupported", "error"];
        };
        readonly operation: {
            readonly $id: "wp-codebox/wordpress-db-operation/v1";
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["schema", "operation"];
            readonly properties: {
                readonly schema: {
                    readonly const: "wp-codebox/wordpress-db-operation/v1";
                };
                readonly operation: {
                    readonly enum: readonly ["schema", "read", "inspect", "query-summary", "write"];
                };
                readonly resource: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly table: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly identifiers: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly type: readonly ["string", "number", "boolean", "null"];
                            };
                        };
                    };
                };
                readonly query: {
                    readonly type: "object";
                    readonly additionalProperties: true;
                    readonly properties: {
                        readonly table: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly columns: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                        readonly where: {
                            readonly type: "object";
                            readonly additionalProperties: {
                                readonly type: readonly ["string", "number", "boolean", "null"];
                            };
                        };
                        readonly limit: {
                            readonly type: "integer";
                            readonly minimum: 1;
                            readonly maximum: 100;
                        };
                        readonly sql: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                };
                readonly options: {
                    readonly type: "object";
                    readonly additionalProperties: true;
                };
                readonly metadata: {
                    readonly type: "object";
                    readonly additionalProperties: true;
                };
            };
        };
        readonly item: {};
        readonly items: {
            readonly type: "array";
        };
        readonly diagnostics: {
            readonly type: "array";
        };
        readonly errors: {
            readonly type: "array";
        };
        readonly artifactRefs: {
            readonly type: "array";
        };
        readonly metadata: {
            readonly type: "object";
            readonly additionalProperties: true;
        };
    };
};
export declare function normalizeWordPressDbOperation(input: unknown): WordPressDbOperation;
export declare function createUnsupportedWordPressDbResult(operation: WordPressDbOperation, message?: string): WordPressDbResult;
//# sourceMappingURL=wordpress-db-contracts.d.ts.map