import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const OPENCODE_INSTANCES =
	"src/lib/domain/daemon/Layers/opencode-instances-layer.ts";

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) return sources(file);
		return file.endsWith(".ts") ? [file] : [];
	});
}

describe("SSE stream Effect boundary", () => {
	it("does not bridge fiber interruption through Effect.runPromise", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/provider/opencode/sse-stream.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/Effect\s*\.\s*run(?:Promise|Sync)\s*\(/);
	});

	it("production project wiring uses the Effect lifecycle API", () => {
		const source = [
			"src/lib/domain/daemon/Layers/project-services-layer.ts",
			"src/lib/domain/daemon/Layers/project-startup.ts",
		]
			.map((path) => readFileSync(join(REPO_ROOT, path), "utf8"))
			.join("\n");

		expect(source).not.toContain("sseStream.connect()");
		expect(source).not.toContain("sseStream.drain()");
		expect(source).toContain("sseStream.connectEffect()");
		expect(source).toContain("SSEStreamLive");
	});

	it("project wiring does not construct or drain SSE as an imperative runtime bridge", () => {
		const source = [
			"src/lib/domain/daemon/Layers/project-services-layer.ts",
			"src/lib/domain/daemon/Layers/project-startup.ts",
		]
			.map((path) => readFileSync(join(REPO_ROOT, path), "utf8"))
			.join("\n");

		expect(source).not.toMatch(/\bnew SSEStream\b/);
	});

	it("only the daemon's OpenCode instances build a stream, once, and drive it through Effect", () => {
		const builders = sources("src/lib").flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(/\bnew SSEStream\b/g)].map(
				() => file,
			),
		);
		expect(builders).toEqual([OPENCODE_INSTANCES]);

		const source = readFileSync(join(REPO_ROOT, OPENCODE_INSTANCES), "utf8");
		expect(source).toContain("source.connectEffect()");
		expect(source).toContain("stream.source.drainEffect()");
		expect(source).not.toMatch(/\.(?:connect|drain)\(\)/);
	});
});
