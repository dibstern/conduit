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
export const MessageSurfacingSettingsSchema = Schema.Struct({
	enabled: Schema.Boolean,
	defaultLevel: SurfacingLevelSchema,
	recap: RecapSettingsSchema,
	tuningModel: Schema.NonEmptyTrimmedString,
});
export type MessageSurfacingPreferences =
	typeof MessageSurfacingSettingsSchema.Type;

export const DEFAULT_MESSAGE_SURFACING_SETTINGS: MessageSurfacingPreferences = {
	enabled: false,
	defaultLevel: "balanced",
	recap: { model: "sonnet", when: "turn-end" },
	// Claude's catalog alias follows the newest Opus without starting a probe.
	tuningModel: "opus",
};

export const MessageSurfacingStatusSchema = Schema.Struct({
	...MessageSurfacingSettingsSchema.fields,
	active: Schema.Boolean,
	key: Schema.Struct({
		state: Schema.Literal("none", "valid", "invalid", "env"),
	}),
});
export type MessageSurfacingStatus = typeof MessageSurfacingStatusSchema.Type;

export const MessageSurfacingPatchSchema = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	apiKey: Schema.optional(Schema.NullOr(Schema.String)),
	defaultLevel: Schema.optional(SurfacingLevelSchema),
	recap: Schema.optional(Schema.partial(RecapSettingsSchema)),
	tuningModel: Schema.optional(Schema.NonEmptyTrimmedString),
});
export type MessageSurfacingPatch = typeof MessageSurfacingPatchSchema.Type;
