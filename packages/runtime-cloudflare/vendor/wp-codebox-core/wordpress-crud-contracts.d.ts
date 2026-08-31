import type { BackendNeutralArtifactRef } from "./runtime-neutral-contracts.js";
export declare const WORDPRESS_CRUD_OPERATION_SCHEMA: "wp-codebox/wordpress-crud-operation/v1";
export declare const WORDPRESS_CRUD_RESULT_SCHEMA: "wp-codebox/wordpress-crud-result/v1";
export type WordPressCrudVerb = "create" | "read" | "update" | "delete" | "list";
export type WordPressCrudResultStatus = "ok" | "unsupported" | "error";
export interface WordPressCrudResourceRef {
    kind: string;
    type?: string;
    id?: string | number;
    path?: string;
    route?: string;
    identifiers?: Record<string, string | number | boolean | null>;
}
export interface WordPressCrudOperation {
    schema: typeof WORDPRESS_CRUD_OPERATION_SCHEMA;
    operation: WordPressCrudVerb;
    resource: WordPressCrudResourceRef;
    data?: Record<string, unknown>;
    query?: Record<string, unknown>;
    options?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export interface WordPressCrudDiagnostic {
    code: string;
    message: string;
    severity?: "info" | "warning" | "error";
    metadata?: Record<string, unknown>;
}
export interface WordPressCrudEffect {
    kind: string;
    resource?: WordPressCrudResourceRef;
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
}
export interface WordPressCrudResult {
    schema: typeof WORDPRESS_CRUD_RESULT_SCHEMA;
    command: "wordpress.crud-operation";
    status: WordPressCrudResultStatus;
    operation: WordPressCrudOperation;
    item?: unknown;
    items?: unknown[];
    effects?: WordPressCrudEffect[];
    diagnostics?: WordPressCrudDiagnostic[];
    errors?: WordPressCrudDiagnostic[];
    artifactRefs?: BackendNeutralArtifactRef[];
    metadata?: Record<string, unknown>;
}
export declare const WORDPRESS_CRUD_OPERATION_JSON_SCHEMA: {
    readonly $id: "wp-codebox/wordpress-crud-operation/v1";
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["schema", "operation", "resource"];
    readonly properties: {
        readonly schema: {
            readonly const: "wp-codebox/wordpress-crud-operation/v1";
        };
        readonly operation: {
            readonly enum: readonly ["create", "read", "update", "delete", "list"];
        };
        readonly resource: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["kind"];
            readonly properties: {
                readonly kind: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly type: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly id: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
                readonly path: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly route: {
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
        readonly data: {
            readonly type: "object";
            readonly additionalProperties: true;
        };
        readonly query: {
            readonly type: "object";
            readonly additionalProperties: true;
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
export declare const WORDPRESS_CRUD_RESULT_JSON_SCHEMA: {
    readonly $id: "wp-codebox/wordpress-crud-result/v1";
    readonly type: "object";
    readonly additionalProperties: true;
    readonly required: readonly ["schema", "command", "status", "operation"];
    readonly properties: {
        readonly schema: {
            readonly const: "wp-codebox/wordpress-crud-result/v1";
        };
        readonly command: {
            readonly const: "wordpress.crud-operation";
        };
        readonly status: {
            readonly enum: readonly ["ok", "unsupported", "error"];
        };
        readonly operation: {
            readonly $id: "wp-codebox/wordpress-crud-operation/v1";
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["schema", "operation", "resource"];
            readonly properties: {
                readonly schema: {
                    readonly const: "wp-codebox/wordpress-crud-operation/v1";
                };
                readonly operation: {
                    readonly enum: readonly ["create", "read", "update", "delete", "list"];
                };
                readonly resource: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly required: readonly ["kind"];
                    readonly properties: {
                        readonly kind: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly type: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly id: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly route: {
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
                readonly data: {
                    readonly type: "object";
                    readonly additionalProperties: true;
                };
                readonly query: {
                    readonly type: "object";
                    readonly additionalProperties: true;
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
        readonly effects: {
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
export declare function normalizeWordPressCrudOperation(input: unknown): WordPressCrudOperation;
export declare function createUnsupportedWordPressCrudResult(operation: WordPressCrudOperation, message?: string): WordPressCrudResult;
//# sourceMappingURL=wordpress-crud-contracts.d.ts.map