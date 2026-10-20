import type { SurfaceTurn } from "./surface-turn.js";

/** Only supplied message ordinals become links; generated text stays escaped. */
export function splitCitations(text: string, messages: SurfaceTurn["numbers"]) {
	return text.split(/(\[#\d+\]|`[^`]+`)/g).map((chunk) => {
		const ordinal = /^\[#(\d+)\]$/.exec(chunk)?.[1];
		const code = /^`([^`]+)`$/.exec(chunk)?.[1];
		return {
			text: ordinal ? "" : (code ?? chunk),
			code: code !== undefined,
			message: ordinal
				? messages.find(({ number }) => number === Number(ordinal))
				: undefined,
		};
	});
}
