import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const CONTRACTS_ROOT = join(REPO_ROOT, "src/lib/contracts");
const FRONTEND_RPC_ENTRY = join(
	REPO_ROOT,
	"src/lib/frontend/transport/ws-rpc.ts",
);
const SERVER_RPC_ENTRY = join(REPO_ROOT, "src/lib/server/ws-rpc.ts");

const forbiddenContractImport =
	/from\s+["'](?:\.\.\/)+(?:daemon|relay|provider|handlers|server|frontend|persistence|domain\/[^"']*\/(?:Services|Layers))[/"']/;

function tsFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...tsFiles(path));
		} else if (path.endsWith(".ts")) {
			files.push(relative(REPO_ROOT, path));
		}
	}
	return files.sort();
}

describe("contracts boundary", () => {
	it("keeps contracts independent from runtime implementations", () => {
		const violations = tsFiles(CONTRACTS_ROOT).filter((file) =>
			forbiddenContractImport.test(readFileSync(join(REPO_ROOT, file), "utf8")),
		);

		expect(violations).toEqual([]);
	});

	it("makes frontend and server consume the same WebSocket RPC contract entry", () => {
		expect(readFileSync(FRONTEND_RPC_ENTRY, "utf8")).toContain(
			"../../contracts/ws-rpc.js",
		);
		expect(readFileSync(SERVER_RPC_ENTRY, "utf8")).toContain(
			"../contracts/ws-rpc.js",
		);
	});
});
