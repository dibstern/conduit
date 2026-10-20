import { Effect, Schema } from "effect";

/** The sticky modifiers, in the order the bar shows them. */
export const TERMINAL_MODIFIERS = ["ctrl", "opt", "cmd", "shift"] as const;
export type TerminalModifier = (typeof TERMINAL_MODIFIERS)[number];

/** Configurable actions. Arrows remain fixed keys. */
export const TERMINAL_KEY_ACTIONS = [
	"paste",
	"copy",
	"esc",
	"tab",
	...TERMINAL_MODIFIERS,
	"return",
	"delete",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"interrupt",
	"nothing",
] as const;
export type TerminalKeyAction = (typeof TERMINAL_KEY_ACTIONS)[number];

const RowKey = Schema.Struct({
	tap: Schema.Literals([...TERMINAL_KEY_ACTIONS]),
	up: Schema.Literals([...TERMINAL_KEY_ACTIONS]),
});
const TerminalKeysRow = Schema.Struct({
	show: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
	hints: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
	keys: Schema.Tuple([RowKey, RowKey, RowKey, RowKey]).pipe(
		Schema.withDecodingDefaultType(
			Effect.sync(() => [
				{ tap: "paste", up: "copy" },
				{ tap: "esc", up: "tab" },
				{ tap: "ctrl", up: "cmd" },
				{ tap: "opt", up: "shift" },
			]),
		),
	),
});

const TerminalKeysBar = Schema.Struct({
	show: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
	paste: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
	escTab: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
	modifiers: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
	arrows: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
});

export const TerminalKeysSetting = Schema.Struct({
	bar: TerminalKeysBar.pipe(
		Schema.withDecodingDefaultType(
			Effect.sync(() => Schema.decodeSync(TerminalKeysBar)({})),
		),
	),
	row: TerminalKeysRow.pipe(
		Schema.withDecodingDefaultType(
			Effect.sync(() => Schema.decodeSync(TerminalKeysRow)({})),
		),
	),
	optionKey: Schema.Literals(["characters", "meta"]).pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => "characters" as const)),
	),
	tapTwiceToLock: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
	pasteAsOneBlock: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => true)),
	),
});
export type TerminalKeysSetting = typeof TerminalKeysSetting.Type;

export const DEFAULT_TERMINAL_KEYS = Schema.decodeSync(TerminalKeysSetting)({});
