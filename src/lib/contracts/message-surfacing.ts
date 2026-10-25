import { Effect, Schema, Struct } from "effect";

export const SurfacingLevelSchema = Schema.Literals([
	"final",
	"key",
	"balanced",
	"all",
]);
export const RecapSettingsSchema = Schema.Struct({
	model: Schema.Literals(["sonnet", "opus", "off"]),
	when: Schema.Literals(["turn-end", "on-request"]),
});
export const TurnsOpenSchema = Schema.Literals([
	"expanded",
	"auto",
	"minimised",
]);
export const MessageSurfacingSettingsSchema = Schema.Struct({
	// Jev alone needs a TypeSafe key. Summaries use the Claude subscription.
	enabled: Schema.Boolean,
	summariesEnabled: Schema.Boolean,
	defaultLevel: SurfacingLevelSchema,
	turnsOpen: TurnsOpenSchema.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => "auto" as const)),
	),
	recap: RecapSettingsSchema,
	tuningModel: Schema.Trimmed.check(Schema.isNonEmpty()),
});
export type MessageSurfacingPreferences =
	typeof MessageSurfacingSettingsSchema.Type;

export const DEFAULT_MESSAGE_SURFACING_SETTINGS: MessageSurfacingPreferences = {
	enabled: false,
	summariesEnabled: true,
	defaultLevel: "balanced",
	turnsOpen: "auto",
	recap: { model: "sonnet", when: "on-request" },
	// Claude's catalog alias follows the newest Opus without starting a probe.
	tuningModel: "opus",
};

export const MessageSurfacingStatusSchema = Schema.Struct({
	...MessageSurfacingSettingsSchema.fields,
	active: Schema.Boolean,
	// Where the key comes from, and whether TypeSafe has refused it. A stored
	// key is validated before it is kept; an environment key on its first 401.
	key: Schema.Struct({
		source: Schema.Literals(["none", "stored", "env"]),
		rejected: Schema.Boolean,
	}),
});
export type MessageSurfacingStatus = typeof MessageSurfacingStatusSchema.Type;

/** Jev runs for a session with a usable key when the session or, by default,
 *  the global switch says so. */
export const sessionJevEnabled = (
	session: { readonly jev?: "on" | "off" | null | undefined } | undefined,
	status: Pick<MessageSurfacingStatus, "enabled" | "key">,
): boolean =>
	status.key.source !== "none" &&
	!status.key.rejected &&
	(session?.jev === "on" || (session?.jev == null && status.enabled));

export const MessageSurfacingPatchSchema = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	summariesEnabled: Schema.optional(Schema.Boolean),
	apiKey: Schema.optional(Schema.NullOr(Schema.String)),
	defaultLevel: Schema.optional(SurfacingLevelSchema),
	turnsOpen: Schema.optional(TurnsOpenSchema),
	recap: Schema.optional(
		RecapSettingsSchema.mapFields(Struct.map(Schema.optional)),
	),
	tuningModel: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
});
export type MessageSurfacingPatch = typeof MessageSurfacingPatchSchema.Type;
