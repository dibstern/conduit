// src/lib/persistence/errors.ts

import { Schema } from "effect";

export const PERSISTENCE_ERROR_CODES = [
	"UNKNOWN_EVENT_TYPE",
	"INVALID_RECEIPT_STATUS",
	"APPEND_FAILED",
	"PROJECTION_FAILED",
	"MIGRATION_FAILED",
	"SCHEMA_VALIDATION_FAILED",
	"CURSOR_MISMATCH",
	"DESERIALIZATION_FAILED",
	"SESSION_SEED_FAILED",
	"DUAL_WRITE_FAILED",
	"WRITE_FAILED",
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

export class PersistenceError extends Schema.TaggedError<PersistenceError>()(
	"PersistenceError",
	{
		message: Schema.String,
		code: Schema.Literal(...PERSISTENCE_ERROR_CODES),
		context: Schema.optionalWith(
			Schema.Record({ key: Schema.String, value: Schema.Unknown }),
			{ default: () => ({}) },
		),
	},
) {
	/** Structured representation for logging. */
	toLog() {
		return {
			error: this._tag,
			code: this.code,
			message: this.message,
			...this.context,
		};
	}
}
