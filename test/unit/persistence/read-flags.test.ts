// test/unit/persistence/read-flags.test.ts
import { describe, expect, it } from "vitest";
import {
	createReadFlags,
	isActive,
	isShadow,
	isSqlite,
	type ReadFlagMode,
} from "../../../src/lib/persistence/read-flags.js";

describe("ReadFlags (three-state)", () => {
	it("defaults all flags to 'legacy'", () => {
		const flags = createReadFlags();
		expect(flags.toolContent).toBe("legacy");
		expect(flags.forkMetadata).toBe("legacy");
		expect(flags.sessionList).toBe("legacy");
		expect(flags.sessionStatus).toBe("legacy");
		expect(flags.sessionHistory).toBe("legacy");
		expect(flags.pendingApprovals).toBe("legacy");
	});

	it("accepts partial overrides", () => {
		const flags = createReadFlags({
			toolContent: "shadow",
			sessionList: "sqlite",
		});
		expect(flags.toolContent).toBe("shadow");
		expect(flags.forkMetadata).toBe("legacy");
		expect(flags.sessionList).toBe("sqlite");
		expect(flags.sessionStatus).toBe("legacy");
	});

	it("accepts all flags as sqlite", () => {
		const flags = createReadFlags({
			toolContent: "sqlite",
			forkMetadata: "sqlite",
			sessionList: "sqlite",
			sessionStatus: "sqlite",
			sessionHistory: "sqlite",
			pendingApprovals: "sqlite",
		});
		expect(flags.toolContent).toBe("sqlite");
		expect(flags.pendingApprovals).toBe("sqlite");
	});

	it("flags are mutable for runtime toggling", () => {
		const flags = createReadFlags();
		expect(flags.toolContent).toBe("legacy");
		flags.toolContent = "shadow";
		expect(flags.toolContent).toBe("shadow");
		flags.toolContent = "sqlite";
		expect(flags.toolContent).toBe("sqlite");
	});

	it("backward compat: boolean true maps to 'sqlite'", () => {
		// Support existing config that may pass booleans during transition
		const flags = createReadFlags({
			toolContent: true as unknown as ReadFlagMode,
		});
		expect(flags.toolContent).toBe("sqlite");
	});

	it("backward compat: boolean false maps to 'legacy'", () => {
		const flags = createReadFlags({
			toolContent: false as unknown as ReadFlagMode,
		});
		expect(flags.toolContent).toBe("legacy");
	});
});

describe("Mode check helpers", () => {
	it("isActive returns true for shadow and sqlite", () => {
		expect(isActive("shadow")).toBe(true);
		expect(isActive("sqlite")).toBe(true);
		expect(isActive("legacy")).toBe(false);
		expect(isActive(undefined)).toBe(false);
	});

	it("isSqlite returns true only for sqlite", () => {
		expect(isSqlite("sqlite")).toBe(true);
		expect(isSqlite("shadow")).toBe(false);
		expect(isSqlite("legacy")).toBe(false);
	});

	it("isShadow returns true only for shadow", () => {
		expect(isShadow("shadow")).toBe(true);
		expect(isShadow("sqlite")).toBe(false);
		expect(isShadow("legacy")).toBe(false);
	});
});
