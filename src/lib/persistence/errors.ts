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
	| "DUAL_WRITE_FAILED";

/**
 * Structured error for the persistence layer.
 */
export class PersistenceError extends Error {
	readonly code: PersistenceErrorCode;
	readonly context: Record<string, unknown>;

	constructor(
		code: PersistenceErrorCode,
		message: string,
		context: Record<string, unknown> = {},
	) {
		super(`[${code}] ${message}`);
		this.name = "PersistenceError";
		this.code = code;
		this.context = context;
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
