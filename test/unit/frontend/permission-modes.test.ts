import { describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "../../../src/lib/frontend/permission-modes.js";
import { toSdkPermissionMode } from "../../../src/lib/provider/claude/permission-mode-map.js";

const modeNames = PERMISSION_MODES.map(({ mode }) => mode);

describe("PERMISSION_MODES", () => {
	it("offers every mode the SDK map knows, with no duplicates", () => {
		expect(new Set(modeNames).size).toBe(modeNames.length);
		for (const mode of modeNames) {
			expect(toSdkPermissionMode(mode)).toBeDefined();
		}
	});

	/** The Claude settings tab builds its Default approval mode list by
	 *  dropping sessionOnly modes. Auto must survive that filter: it is the
	 *  one Claude-only mode PermissionModeSelector normalises away on a
	 *  non-Claude provider, so a session can inherit it and still recover. */
	it("allows auto as a default and keeps plan and dontAsk session-only", () => {
		const defaults = PERMISSION_MODES.filter(({ sessionOnly }) => !sessionOnly);
		expect(defaults.map(({ mode }) => mode)).toEqual([
			"ask",
			"acceptEdits",
			"auto",
			"full",
		]);
	});

	it("flags only the modes that relax approvals as elevated", () => {
		const elevated = PERMISSION_MODES.filter((m) => m.elevated).map(
			({ mode }) => mode,
		);
		// "dontAsk" is more restrictive than "ask", so tinting it would invert
		// the signal the elevated flag exists to give.
		expect(elevated).toEqual(["acceptEdits", "auto", "full"]);
	});
});
