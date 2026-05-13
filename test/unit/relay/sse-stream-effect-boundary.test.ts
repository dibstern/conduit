import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

describe("SSE stream Effect boundary", () => {
	it("does not bridge fiber interruption through Effect.runPromise", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/relay/sse-stream.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/Effect\s*\.\s*run(?:Promise|Sync)\s*\(/);
	});

	it("production relay wiring uses the Effect lifecycle API", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/relay/relay-stack.ts"),
			"utf8",
		);

		expect(source).not.toContain("sseStream.connect()");
		expect(source).not.toContain("sseStream.drain()");
		expect(source).toContain("sseStream.connectEffect()");
		expect(source).toContain("sseStream.drainEffect()");
	});
});
