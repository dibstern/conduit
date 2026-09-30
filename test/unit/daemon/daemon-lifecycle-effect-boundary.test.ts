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

		expect(source).toContain(
			"Schema.decodeUnknownEither(IpcTaggedRequestSchema)",
		);
		expect(source).not.toMatch(/Effect\s*\.\s*run(?:Promise|Sync)/);
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

	it("has only the tagged IPC dispatch path", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/daemon/daemon-lifecycle.ts"),
			"utf8",
		);

		expect(source).toContain("dispatchTaggedRequest(decoded.right)");
		expect(source).not.toContain("DEPRECATED");
	});
});
