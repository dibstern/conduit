import { Schema } from "effect";

export const AVATAR_PRESET_IDS = [
	"fox",
	"octopus",
	"saturn",
	"cactus",
	"lemon",
	"whale",
	"orb-violet",
	"orb-sunset",
	"orb-ocean",
	"orb-amber",
	"orb-mint",
	"orb-pink",
] as const;

export const AvatarChoiceSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("initial") }),
	Schema.Struct({ kind: Schema.Literal("mac") }),
	Schema.Struct({
		kind: Schema.Literal("preset"),
		id: Schema.Literals([...AVATAR_PRESET_IDS]),
	}),
	Schema.Struct({
		kind: Schema.Literal("shape"),
		seed: Schema.Number.pipe(
			Schema.check(Schema.isInt()),
			Schema.check(
				Schema.isBetween({ minimum: -2147483648, maximum: 2147483647 }),
			),
		),
	}),
]);
export type AvatarChoice = typeof AvatarChoiceSchema.Type;

export const AvatarSchema = Schema.Struct({
	choice: Schema.NullOr(AvatarChoiceSchema),
	name: Schema.String,
	macPicture: Schema.NullOr(Schema.String),
});
export type Avatar = typeof AvatarSchema.Type;
