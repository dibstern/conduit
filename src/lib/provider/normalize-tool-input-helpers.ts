import { isRecord } from "../utils.js";

export function toRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function str(input: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string") return value;
	}
	return "";
}

export function optStr(
	input: Record<string, unknown>,
	key: string,
	...aliases: string[]
): Record<string, string> {
	for (const field of [key, ...aliases]) {
		const value = input[field];
		if (typeof value === "string" && value.length > 0) return { [key]: value };
	}
	return {};
}

/** Recognize plain apply-patch path headers, never paths in patch content. */
export function patchFilePaths(patch: string): readonly string[] {
	const lines = patch.trim().split(/\r?\n/);
	if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch")
		return [];
	const paths = new Set<string>();
	for (const line of lines.slice(1, -1)) {
		const header = line.match(
			/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/,
		);
		if (header?.[1]) paths.add(header[1]);
	}
	return [...paths];
}

export function optNum(
	input: Record<string, unknown>,
	key: string,
): Record<string, number> {
	const value = input[key];
	return typeof value === "number" ? { [key]: value } : {};
}
