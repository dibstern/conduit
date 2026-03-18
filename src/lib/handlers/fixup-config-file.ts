// ─── Workaround: OpenCode config.json write bug ─────────────────────────────
//
// OpenCode's Config.update() hardcodes "config.json" as the write target
// instead of respecting the project's existing config file (opencode.jsonc or
// opencode.json).  This creates a spurious config.json that is never loaded as
// project config on restart.
//
// Upstream fix: https://github.com/anomalyco/opencode/pull/16979
//
// This workaround runs after every updateConfig() call.  When the upstream fix
// lands, config.json is never created so this becomes a no-op.
//
// TODO: Remove this file once the upstream fix is released.

import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.js";

/**
 * Resolve the correct project config file to write to.
 * Prefers an existing opencode.jsonc, then opencode.json.
 * Falls back to creating opencode.json if neither exists.
 */
function resolveTargetConfigFile(projectDir: string): string {
	const jsonc = join(projectDir, "opencode.jsonc");
	if (existsSync(jsonc)) return jsonc;
	return join(projectDir, "opencode.json");
}

/**
 * If OpenCode wrote a spurious config.json in the project directory, merge its
 * contents into the correct project config file (opencode.jsonc or opencode.json)
 * and delete config.json.
 *
 * Safe to call unconditionally — returns immediately when config.json does not
 * exist (i.e. the upstream fix is active).
 */
export async function fixupConfigFile(
	projectDir: string,
	log: Logger,
): Promise<void> {
	const spurious = join(projectDir, "config.json");
	if (!existsSync(spurious)) return; // upstream fix is active — nothing to do

	const target = resolveTargetConfigFile(projectDir);

	try {
		const raw = await readFile(spurious, "utf-8");
		const patch = JSON.parse(raw) as Record<string, unknown>;

		// Merge patch into existing config, or create fresh from patch
		let existing: Record<string, unknown> = {};
		if (existsSync(target)) {
			try {
				// jsonc is a superset of JSON — strip comments with a simple regex
				// so JSON.parse can handle it. We write back as plain JSON (valid jsonc).
				const content = await readFile(target, "utf-8");
				const stripped = content
					.replace(/\/\/[^\n]*/g, "")
					.replace(/\/\*[\s\S]*?\*\//g, "");
				existing = JSON.parse(stripped) as Record<string, unknown>;
			} catch {
				// If the file is malformed, proceed with an empty base — the patch
				// content will still be written correctly.
			}
		}

		const merged = deepMerge(existing, patch);
		await writeFile(target, `${JSON.stringify(merged, null, "\t")}\n`);
		await unlink(spurious);
		const targetName = target.endsWith("opencode.jsonc")
			? "opencode.jsonc"
			: "opencode.json";
		log.info(
			`[fixup] Merged config.json → ${targetName} (upstream config.json write bug workaround)`,
		);
	} catch (err) {
		log.warn(`[fixup] Failed to relocate spurious config.json: ${err}`);
	}
}

/** Simple recursive merge — objects are merged, primitives are overwritten. */
function deepMerge(
	base: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (isRecord(result[key]) && isRecord(value)) {
			result[key] = deepMerge(
				result[key] as Record<string, unknown>,
				value as Record<string, unknown>,
			);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
