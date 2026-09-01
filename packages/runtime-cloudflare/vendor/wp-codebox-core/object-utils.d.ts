export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function objectValue(value: unknown): Record<string, unknown>;
export declare function optionalObjectValue(value: unknown): Record<string, unknown> | undefined;
export declare function stringValue(value: unknown): string;
export declare function numberValue(value: unknown): number | undefined;
export declare function errorMessage(error: unknown): string;
export declare function parseJsonObject(text: string): unknown;
export declare function now(): string;
export declare function sha256(contents: string | Buffer): string;
export declare function stableJson(value: unknown): string;
export declare function normalizeJsonValue(value: unknown, seen?: WeakSet<object>, depth?: number): unknown;
export declare function sha256StableJson(value: unknown, trailingNewline?: boolean): string;
export declare function stripUndefined<T extends Record<string, unknown>>(record: T): T;
export declare function stringList(value: unknown): string[];
//# sourceMappingURL=object-utils.d.ts.map