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
