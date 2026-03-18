import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import type { Base16Theme } from "../shared-types.js";
import { BASE16_KEYS } from "../shared-types.js";

export type { Base16Theme };

export function validateTheme(t: unknown): t is Base16Theme {
	if (!t || typeof t !== "object") return false;
	const obj = t as Record<string, unknown>;
	if (!obj["name"] || typeof obj["name"] !== "string") return false;
	for (const key of BASE16_KEYS) {
		if (!obj[key] || typeof obj[key] !== "string") return false;
		if (!/^[0-9a-fA-F]{6}$/.test(obj[key] as string)) return false;
	}
	if (obj["variant"] && obj["variant"] !== "dark" && obj["variant"] !== "light")
		return false;
	// Validate overrides: must be a plain object with string values if present
	if (obj["overrides"] != null) {
		if (typeof obj["overrides"] !== "object" || Array.isArray(obj["overrides"]))
			return false;
		for (const v of Object.values(
			obj["overrides"] as Record<string, unknown>,
		)) {
			if (typeof v !== "string") return false;
		}
	}
	if (!obj["variant"]) {
		const hex = obj["base00"] as string;
		const r = parseInt(hex.substring(0, 2), 16);
		const g = parseInt(hex.substring(2, 4), 16);
		const b = parseInt(hex.substring(4, 6), 16);
		const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
		(obj as Record<string, string>)["variant"] = lum > 0.5 ? "light" : "dark";
	}
	return true;
}

async function readThemesFromDir(
	dir: string,
): Promise<Record<string, Base16Theme>> {
	const themes: Record<string, Base16Theme> = {};
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return themes;
	}
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const raw = await readFile(join(dir, file), "utf-8");
			const parsed = JSON.parse(raw);
			if (validateTheme(parsed)) {
				const id = basename(file, ".json");
				themes[id] = parsed as Base16Theme;
			}
		} catch {
			// Skip invalid files
		}
	}
	return themes;
}

function getBundledThemesDir(): string {
	const thisFile = fileURLToPath(import.meta.url);
	return join(thisFile, "..", "..", "themes");
}

function getCustomThemesDir(): string {
	return join(DEFAULT_CONFIG_DIR, "themes");
}

export async function loadThemeFiles(): Promise<{
	bundled: Record<string, Base16Theme>;
	custom: Record<string, Base16Theme>;
}> {
	const [bundled, custom] = await Promise.all([
		readThemesFromDir(getBundledThemesDir()),
		readThemesFromDir(getCustomThemesDir()),
	]);
	return { bundled, custom };
}
