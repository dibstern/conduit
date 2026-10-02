import { Schema } from "effect";

/** Private generation identity for a detached, supervised OpenCode group. */
export const ManagedOpenCodeProcessIdentitySchema = Schema.Struct({
	supervisorPid: Schema.Number.pipe(Schema.int(), Schema.positive()),
	controlPort: Schema.Number.pipe(Schema.int(), Schema.between(1, 65535)),
	token: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
});

export type ManagedOpenCodeProcessIdentity =
	typeof ManagedOpenCodeProcessIdentitySchema.Type;
