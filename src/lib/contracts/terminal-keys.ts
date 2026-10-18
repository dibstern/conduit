import { Schema } from "effect";

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
	optionKey: Schema.optionalWith(Schema.Literal("characters", "meta"), {
		default: () => "characters" as const,
	}),
	tapTwiceToLock: Schema.optionalWith(Schema.Boolean, { default: () => true }),
	pasteAsOneBlock: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});
export type TerminalKeysSetting = typeof TerminalKeysSetting.Type;

export const DEFAULT_TERMINAL_KEYS = Schema.decodeSync(TerminalKeysSetting)({});

/** The sticky modifiers, in the order the bar shows them. */
export const TERMINAL_MODIFIERS = ["ctrl", "opt", "cmd", "shift"] as const;
export type TerminalModifier = (typeof TERMINAL_MODIFIERS)[number];

/** What an on-screen terminal key can send. One list for the terminal keys
 *  module, the phone row, its picker and the setting; it grows as each action
 *  is built. Arrows are not actions: they are fixed keys, never configurable. */
export const TERMINAL_KEY_ACTIONS = [
	"paste",
	"copy",
	"esc",
	"tab",
	...TERMINAL_MODIFIERS,
] as const;
export type TerminalKeyAction = (typeof TERMINAL_KEY_ACTIONS)[number];
