import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

describe("daemon lifecycle Effect boundary", () => {
	it("keeps HTTP lifecycle helpers outside the Effect runtime", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/daemon/daemon-lifecycle.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/Effect\s*\.\s*run(?:Promise|Sync)/);
	});

	it("does not own a private daemon request dispatcher", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/daemon/daemon-lifecycle.ts"),
			"utf8",
		);

		expect(source).not.toMatch(
			/Runtime\.runPromise\(Runtime\.defaultRuntime\)/,
		);
		expect(source).not.toMatch(/dispatchTaggedRequest|startIPCServer/);
	});

	it("has removed the private IPC contract and handlers", () => {
		for (const path of [
			"src/lib/contracts/ipc-requests.ts",
			"src/lib/daemon/ipc-protocol.ts",
			"src/lib/domain/daemon/Services/ipc-rpc-group.ts",
			"src/lib/domain/daemon/Services/ipc-handlers.ts",
		]) {
			expect(existsSync(join(REPO_ROOT, path))).toBe(false);
		}
	});
});
