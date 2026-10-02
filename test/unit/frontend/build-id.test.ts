import { describe, expect, it } from "vitest";
import { claimBuildReload } from "../../../src/lib/frontend/utils/build-id.js";

describe("build ID reload guard", () => {
	const storage = () => {
		const entries = new Map<string, string>();
		return {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => {
				entries.set(key, value);
			},
		};
	};

	it("reloads once for a different server build, including across page loads", () => {
		const tabStorage = storage();
		expect(claimBuildReload("A", "B", tabStorage)).toBe("reload");
		expect(claimBuildReload("A", "B", tabStorage)).toBe("warn");
	});

	it("remembers each server build when reconnecting between servers", () => {
		const tabStorage = storage();
		expect(claimBuildReload("A", "B", tabStorage)).toBe("reload");
		expect(claimBuildReload("A", "C", tabStorage)).toBe("reload");
		expect(claimBuildReload("A", "B", tabStorage)).toBe("warn");
	});

	it.each([
		["A", "A"],
		["dev", "A"],
		["A", "dev"],
		["dev", "dev"],
		["A", undefined],
		["A", ""],
	])("does not reload %s against %s, even without storage", (page, server) => {
		const unavailable = {
			getItem: () => {
				throw new Error("storage unavailable");
			},
			setItem: () => {
				throw new Error("storage unavailable");
			},
		};
		expect(claimBuildReload(page, server, unavailable)).toBe("current");
	});

	it("warns instead of risking a loop when storage cannot be read", () => {
		expect(
			claimBuildReload("A", "B", {
				...storage(),
				getItem: () => {
					throw new Error("storage unavailable");
				},
			}),
		).toBe("warn");
	});

	it("warns instead of risking a loop when the marker cannot be saved", () => {
		expect(
			claimBuildReload("A", "B", {
				...storage(),
				setItem: () => {
					throw new Error("quota exceeded");
				},
			}),
		).toBe("warn");
	});

	it("does not forget a previous reload after a matching handshake", () => {
		const tabStorage = storage();
		expect(claimBuildReload("A", "B", tabStorage)).toBe("reload");
		expect(claimBuildReload("B", "B", tabStorage)).toBe("current");
		expect(claimBuildReload("A", "B", tabStorage)).toBe("warn");
	});
});
