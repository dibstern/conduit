import { Schema } from "effect";

/** Private generation identity for a detached, supervised OpenCode group. */
export const ManagedOpenCodeProcessIdentitySchema = Schema.Struct({
	supervisorPid: Schema.Number.pipe(
		Schema.check(Schema.isInt()),
		Schema.check(Schema.isGreaterThan(0)),
	),
	controlPort: Schema.Number.pipe(
		Schema.check(Schema.isInt()),
		Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
	),
	token: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});

export type ManagedOpenCodeProcessIdentity =
	typeof ManagedOpenCodeProcessIdentitySchema.Type;
