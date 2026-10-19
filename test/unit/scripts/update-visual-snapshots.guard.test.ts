import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = readFileSync(
	join(repoRoot, "scripts/update-visual-snapshots.sh"),
	"utf8",
);

/**
 * Executable body of a `name() { ... }` shell function -- comments stripped.
 *
 * Stripping matters: both functions *explain* VISUAL_STRICT=1 in a comment, so a
 * naive substring check passes even when the flag has been removed from the
 * command. Verified by deleting the flag and watching the test stay green.
 */
function executableBody(name: string): string {
	const match = new RegExp(`^${name}\\(\\) \\{$([\\s\\S]*?)^\\}$`, "m").exec(
		script,
	);
	expect(
		match,
		`${name}() not found in update-visual-snapshots.sh`,
	).not.toBeNull();
	return (match?.[1] ?? "")
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

// `playwright test --update-snapshots` defaults to mode `changed`, which respects
// the configured maxDiffPixelRatio. A baseline whose real drift falls under that
// tolerance is then silently left stale while the run reports success -- which is
// how a full palette swap once rewrote 736 linux baselines and only 133 darwin
// ones. VISUAL_STRICT=1 sets the threshold to 0 so "changed" means "differs at
// all". It is load-bearing on BOTH legs; regressing either one is silent.
describe("update-visual-snapshots.sh", () => {
	it.each([
		"update_macos",
		"update_linux",
	])("%s runs the update under VISUAL_STRICT=1", (fn) => {
		expect(executableBody(fn)).toMatch(/VISUAL_STRICT=1/);
	});
});
