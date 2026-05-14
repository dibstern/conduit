import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

describe("daemon lifecycle Effect boundary", () => {
	it("does not run an Effect for pure tagged IPC request decoding", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/daemon/daemon-lifecycle.ts"),
			"utf8",
		);

		expect(source).not.toMatch(
			/Effect\s*\.\s*run(?:Promise|Sync)\s*\(\s*decodeTaggedRequest\s*\(/,
		);
	});

	it("does not own a default runtime dispatcher for tagged IPC", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/daemon/daemon-lifecycle.ts"),
			"utf8",
		);

		expect(source).not.toMatch(
			/Runtime\.runPromise\(Runtime\.defaultRuntime\)/,
		);
		expect(source).not.toMatch(/defaultTaggedIpcDispatcher/);
	});

	it("does not dispatch legacy cmd IPC through the old promise router", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/daemon/daemon-lifecycle.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/createCommandRouter/);
		expect(source).not.toMatch(/router\(cmd\)/);
	});
});
