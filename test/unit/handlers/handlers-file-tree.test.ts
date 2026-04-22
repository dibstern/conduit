// ─── File Tree Handler Tests ─────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { handleGetFileTree } from "../../../src/lib/handlers/files.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

function makeDeps(
	listDirectoryImpl: (
		path?: string,
	) => Promise<Array<{ name: string; type: string }>>,
): { deps: HandlerDeps; sent: Array<{ clientId: string; msg: unknown }> } {
	const sent: Array<{ clientId: string; msg: unknown }> = [];
	const deps = createMockHandlerDeps({
		client: {
			file: { list: listDirectoryImpl },
		} as unknown as HandlerDeps["client"],
		wsHandler: {
			sendTo: (clientId: string, msg: unknown) => {
				sent.push({ clientId, msg });
			},
		} as unknown as HandlerDeps["wsHandler"],
	});
	return { deps, sent };
}

describe("handleGetFileTree", () => {
	it("returns flat list of files and directories", async () => {
		const { deps, sent } = makeDeps(async (path) => {
			if (!path || path === ".") {
				return [
					{ name: "index.ts", type: "file" },
					{ name: "src", type: "directory" },
				];
			}
			if (path === "src") {
				return [{ name: "app.ts", type: "file" }];
			}
			return [];
		});

		await handleGetFileTree(deps, "client-1", {});

		expect(sent).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const msg = sent[0]!.msg as { type: string; entries: string[] };
		expect(msg.type).toBe("file_tree");
		expect(msg.entries).toContain("index.ts");
		expect(msg.entries).toContain("src/");
		expect(msg.entries).toContain("src/app.ts");
	});

	it("handles empty directory", async () => {
		const { deps, sent } = makeDeps(async () => []);

		await handleGetFileTree(deps, "client-1", {});

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const msg = sent[0]!.msg as { type: string; entries: string[] };
		expect(msg.type).toBe("file_tree");
		expect(msg.entries).toEqual([]);
	});

	it("handles listDirectory errors gracefully", async () => {
		const { deps, sent } = makeDeps(async () => {
			throw new Error("Permission denied");
		});

		await handleGetFileTree(deps, "client-1", {});

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const msg = sent[0]!.msg as { type: string; entries: string[] };
		expect(msg.type).toBe("file_tree");
		expect(msg.entries).toEqual([]);
	});
});
