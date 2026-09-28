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
): Record<string, string> {
	const value = input[key];
	return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}

export function optNum(
	input: Record<string, unknown>,
	key: string,
): Record<string, number> {
	const value = input[key];
	return typeof value === "number" ? { [key]: value } : {};
}
