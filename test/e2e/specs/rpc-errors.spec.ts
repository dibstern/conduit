import { expect, test } from "@playwright/test";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { build } from "vite";
import { WorkspaceMoveError } from "../../../src/lib/contracts/session-workspace.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";

// Failure modes: declared copy replaces the action; null copy leaks an error;
// socket closure shows transport details; a generic refusal loses its message.
let browserCode: string;
test.beforeAll(async () => {
	const output = await build({
		configFile: false,
		logLevel: "error",
		plugins: [svelte()],
		resolve: { conditions: ["browser"] },
		build: {
			write: false,
			minify: false,
			lib: {
				entry: new URL("../helpers/rpc-error-browser.ts", import.meta.url)
					.pathname,
				formats: ["es"],
			},
		},
	});
	if (!("output" in output) && !Array.isArray(output))
		throw new Error("Expected browser bundle");
	const chunk = (Array.isArray(output) ? output[0] : output)?.output.find(
		(item) => item.type === "chunk" && item.isEntry,
	);
	if (chunk?.type !== "chunk") throw new Error("Missing browser entry");
	browserCode = chunk.code;
});

for (const scenario of ["copy", "null", "socket", "generic"] as const) {
	test(`${scenario} RPC failure shows the action and only the available copy`, async ({
		page,
	}, testInfo) => {
		const mock = await mockWsRpc(page, {
			stubs: {
				MoveSessionWorkspace: () => {
					if (scenario === "generic")
						throw new WsRpcError({ message: "Permission denied" });
					if (scenario === "socket") return new Promise<never>(() => {});
					throw new WorkspaceMoveError({ path: "/gone", reason: "missing" });
				},
			},
		});
		await page.route("http://rpc.test/", (route) =>
			route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
		);
		await page.goto("http://rpc.test/");
		await page.addScriptTag({ type: "module", content: browserCode });
		await page.waitForFunction(
			() => typeof window.showRpcFailure === "function",
		);
		const showing = page.evaluate(
			(nullCopy) => window.showRpcFailure(nullCopy),
			scenario === "null",
		);
		if (scenario === "socket") {
			await expect
				.poll(() =>
					mock.getRequests().some(({ tag }) => tag === "MoveSessionWorkspace"),
				)
				.toBe(true);
			mock.closeSockets();
		}
		await showing;
		const toast = page.getByRole("alert");
		await expect(toast).toContainText("Could not move session");
		if (scenario === "copy")
			await expect(toast).toContainText("That worktree no longer exists.");
		else if (scenario === "generic")
			await expect(toast).toContainText("Permission denied");
		else await expect(toast).toHaveText("Could not move session");
		const artifact = testInfo.outputPath(`${scenario}-rpc-error.png`);
		await page.screenshot({ path: artifact });
		await testInfo.attach(`${scenario}-rpc-error`, {
			path: artifact,
			contentType: "image/png",
		});
	});
}
