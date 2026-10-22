/**
 * Splits plain text around bare http(s) URLs: odd indices are URLs. Trailing
 * punctuation stays outside, as in GFM autolinks, so a URL ending a sentence
 * or clause ("…/differences/,") keeps its comma in the prose.
 */
export function splitUrls(text: string): string[] {
	return text.split(/(https?:\/\/[^\s<>`]*[^\s<>`.,:;!?'")\]])/g);
}
