// src/lib/persistence/errors.ts

/**
 * Error codes for the persistence layer.
 */
export type PersistenceErrorCode =
	| "UNKNOWN_EVENT_TYPE"
	| "INVALID_RECEIPT_STATUS"
	| "APPEND_FAILED"
	| "PROJECTION_FAILED"
	| "MIGRATION_FAILED"
	| "SCHEMA_VALIDATION_FAILED"
	| "CURSOR_MISMATCH"
	| "DESERIALIZATION_FAILED"
	| "SESSION_SEED_FAILED"
	| "DUAL_WRITE_FAILED"
	| "WRITE_FAILED";

/**
 * Structured error for the persistence layer.
 */
export class PersistenceError extends Error {
	readonly _tag = "PersistenceError" as const;
	readonly code: PersistenceErrorCode;
	readonly context: Record<string, unknown>;

	constructor(props: {
		code: PersistenceErrorCode;
		message: string;
		context?: Record<string, unknown>;
	}) {
		super(`[${props.code}] ${props.message}`);
		this.name = "PersistenceError";
		this.code = props.code;
		this.context = props.context ?? {};
	}

	/** Structured representation for logging. */
	toLog(): Record<string, unknown> {
		return {
			code: this.code,
			message: this.message,
			...this.context,
		};
	}
}
