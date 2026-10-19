import { Schema } from "effect";

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
	tap: Schema.Literal(...TERMINAL_KEY_ACTIONS),
	up: Schema.Literal(...TERMINAL_KEY_ACTIONS),
});
const TerminalKeysRow = Schema.Struct({
	show: Schema.optionalWith(Schema.Boolean, { default: () => true }),
	hints: Schema.optionalWith(Schema.Boolean, { default: () => true }),
	keys: Schema.optionalWith(Schema.Tuple(RowKey, RowKey, RowKey, RowKey), {
		default: () => [
			{ tap: "paste", up: "copy" },
			{ tap: "esc", up: "tab" },
			{ tap: "ctrl", up: "cmd" },
			{ tap: "opt", up: "shift" },
		],
	}),
});

const TerminalKeysBar = Schema.Struct({
	show: Schema.optionalWith(Schema.Boolean, { default: () => true }),
	paste: Schema.optionalWith(Schema.Boolean, { default: () => true }),
	escTab: Schema.optionalWith(Schema.Boolean, { default: () => true }),
	modifiers: Schema.optionalWith(Schema.Boolean, { default: () => true }),
	arrows: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

export const TerminalKeysSetting = Schema.Struct({
	bar: Schema.optionalWith(TerminalKeysBar, {
		default: () => Schema.decodeSync(TerminalKeysBar)({}),
	}),
	row: Schema.optionalWith(TerminalKeysRow, {
		default: () => Schema.decodeSync(TerminalKeysRow)({}),
	}),
	optionKey: Schema.optionalWith(Schema.Literal("characters", "meta"), {
		default: () => "characters" as const,
	}),
	tapTwiceToLock: Schema.optionalWith(Schema.Boolean, { default: () => true }),
	pasteAsOneBlock: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});
export type TerminalKeysSetting = typeof TerminalKeysSetting.Type;

export const DEFAULT_TERMINAL_KEYS = Schema.decodeSync(TerminalKeysSetting)({});
