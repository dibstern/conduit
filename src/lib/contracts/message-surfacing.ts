import { Schema } from "effect";

export const SurfacingLevelSchema = Schema.Literal(
	"final",
	"key",
	"balanced",
	"all",
);
export const RecapSettingsSchema = Schema.Struct({
	model: Schema.Literal("sonnet", "opus", "off"),
	when: Schema.Literal("turn-end", "on-request"),
});
export const TurnsOpenSchema = Schema.Literal("expanded", "auto", "minimised");
export const MessageSurfacingSettingsSchema = Schema.Struct({
	// Jev alone needs a TypeSafe key. Summaries use the Claude subscription.
	enabled: Schema.Boolean,
	summariesEnabled: Schema.Boolean,
	defaultLevel: SurfacingLevelSchema,
	turnsOpen: Schema.optionalWith(TurnsOpenSchema, {
		default: () => "auto" as const,
	}),
	recap: RecapSettingsSchema,
	tuningModel: Schema.NonEmptyTrimmedString,
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
		source: Schema.Literal("none", "stored", "env"),
		rejected: Schema.Boolean,
	}),
});
export type MessageSurfacingStatus = typeof MessageSurfacingStatusSchema.Type;

export const MessageSurfacingPatchSchema = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	summariesEnabled: Schema.optional(Schema.Boolean),
	apiKey: Schema.optional(Schema.NullOr(Schema.String)),
	defaultLevel: Schema.optional(SurfacingLevelSchema),
	turnsOpen: Schema.optional(TurnsOpenSchema),
	recap: Schema.optional(Schema.partial(RecapSettingsSchema)),
	tuningModel: Schema.optional(Schema.NonEmptyTrimmedString),
});
export type MessageSurfacingPatch = typeof MessageSurfacingPatchSchema.Type;
