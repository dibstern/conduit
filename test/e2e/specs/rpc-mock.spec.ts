import { writeFile } from "node:fs/promises";
import { RpcSchema } from "@effect/rpc";
import { expect, test } from "@playwright/test";
import { Arbitrary, Schema, Stream } from "effect";
import fc from "fast-check";
import { build } from "vite";
import {
	ProjectSaveRejected,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { MOCK_SERVER_STATUS, mockWsRpc } from "../helpers/rpc-mock.js";

let browserCode: string;
test.describe.configure({ mode: "default" });
test.beforeAll(async () => {
	const output = await build({
		configFile: false,
		logLevel: "error",
		build: {
			write: false,
			minify: false,
			lib: {
				entry: new URL("../helpers/rpc-browser.ts", import.meta.url).pathname,
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

test("prototype: a declared error reaches the browser as its class over Playwright", async ({
	page,
}, testInfo) => {
	await mockWsRpc(page, {
		stubs: {
			SaveProject: () => {
				throw new ProjectSaveRejected({ issues: [] });
			},
		},
	});
	await page.route("http://rpc.test/", (route) =>
		route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
	);
	await page.goto("http://rpc.test/");
	await page.addScriptTag({ type: "module", content: browserCode });
	await page.waitForFunction(() => typeof window.callRpc === "function");
	const result = await page.evaluate(() =>
		window.callRpc("SaveProject", { folders: [] }),
	);
	expect(result).toEqual({
		error: { _tag: "ProjectSaveRejected", issues: [] },
		isInstance: true,
	});
	await testInfo.attach("declared-error-browser-result", {
		body: JSON.stringify(result, null, 2),
		contentType: "application/json",
	});
});

async function openClient(page: import("@playwright/test").Page) {
	await page.route("http://rpc.test/", (route) =>
		route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
	);
	await page.goto("http://rpc.test/");
	await page.addScriptTag({ type: "module", content: browserCode });
	await page.waitForFunction(() => typeof window.callRpc === "function");
}

test("every declared error class reaches the browser", async ({
	page,
}, testInfo) => {
	const checked = new Set<string>();
	const results: unknown[] = [];
	for (const rpc of WsRpcGroup.requests.values()) {
		const stream = RpcSchema.getStreamSchemas(rpc.successSchema.ast);
		const variants =
			stream._tag === "Some"
				? [rpc.errorSchema.ast, stream.value.failure.ast]
				: [rpc.errorSchema.ast];
		for (const ast of variants) {
			if (ast._tag === "Union") {
				variants.push(...ast.types);
				continue;
			}
			if (ast._tag === "Suspend") {
				variants.push(ast.f());
				continue;
			}
			if (ast._tag === "NeverKeyword") continue;
			const error = fc.sample(Arbitrary.make(Schema.make(ast)), {
				seed: 42,
				numRuns: 1,
			})[0];
			if (typeof error !== "object" || error === null || !("_tag" in error))
				throw new Error("Untagged declared error");
			if (checked.has(String(error._tag))) continue;
			checked.add(String(error._tag));
			const payload = fc.sample(
				Arbitrary.make(Schema.make(rpc.payloadSchema.ast)),
				{ seed: 42, numRuns: 1 },
			)[0];
			await mockWsRpc(page, {
				stubs: {
					[rpc._tag]: () => {
						if (stream._tag === "Some") return Stream.fail(error);
						throw error;
					},
				},
			});
			if (checked.size === 1) await openClient(page);
			const result = await page.evaluate(
				({ tag, payload }) => window.callRpc(tag, payload),
				{ tag: rpc._tag, payload },
			);
			expect(result, rpc._tag).toEqual({
				error: JSON.parse(JSON.stringify(error)),
				isInstance: true,
			});
			results.push({ rpc: rpc._tag, ...result });
		}
	}
	expect(checked.size).toBeGreaterThan(5);
	const artifact = testInfo.outputPath("all-declared-errors.json");
	await writeFile(artifact, `${JSON.stringify(results, null, 2)}\n`);
	await testInfo.attach("all-declared-errors", { path: artifact });
});

test("typed and legacy entries coexist with control overrides", async ({
	page,
}) => {
	const control = await mockWsRpc(page, {
		stubs: {
			SetLogLevel: () => ({ ok: true }),
			"input.submit": ({ sessionId }) => ({
				ok: true,
				sessionId,
				handedOff: true,
			}),
		},
		handlers: { GetStatus: () => MOCK_SERVER_STATUS },
	});
	let submitted: Record<string, unknown> | undefined;
	control.onSendMessage = (payload) => {
		submitted = payload;
	};
	await openClient(page);
	expect(
		await page.evaluate(() =>
			window.callRpc("SetLogLevel", { level: "debug" }),
		),
	).toEqual({ value: { ok: true } });
	expect(
		await page.evaluate(() =>
			window.callRpc("input.submit", {
				projectSlug: "p",
				sessionId: "s",
				inputId: "i",
				text: "hello",
				delivery: "queue",
			}),
		),
	).toEqual({ value: { ok: true, sessionId: "s", handedOff: true } });
	expect(submitted).toMatchObject({
		sessionId: "s",
		inputId: "i",
		text: "hello",
	});
	expect(await page.evaluate(() => window.callRpc("GetStatus", {}))).toEqual({
		value: MOCK_SERVER_STATUS,
	});
	control.setResponse("GetStatus", { ...MOCK_SERVER_STATUS, clientCount: 9 });
	expect(await page.evaluate(() => window.callRpc("GetStatus", {}))).toEqual({
		value: { ...MOCK_SERVER_STATUS, clientCount: 9 },
	});
});

test("a legacy invalid reply warns and becomes a defect", async ({ page }) => {
	await mockWsRpc(page, {
		handlers: {
			GetStatus: () => ({ ...MOCK_SERVER_STATUS, clientCount: "invalid" }),
		},
	});
	await openClient(page);
	const result = await page.evaluate(() => window.callRpc("GetStatus", {}));
	expect(result).toHaveProperty("defect");
});

test("an invalid typed reply fails its owning spec", async ({ page }) => {
	await mockWsRpc(page, {
		stubs: {
			// @ts-expect-error Exercise schema validation for stale fixtures at runtime.
			ListWorktrees: () => ({ worktrees: "invalid" }),
		},
	});
	await openClient(page);
	await page.evaluate(() =>
		window.callRpc("ListWorktrees", { projectSlug: "p" }),
	);
	test.fail(
		true,
		"The mock must fail the spec even when the caller handles the defect",
	);
});

for (const typed of [false, true]) {
	test(`${typed ? "typed" : "default"} streams accept queued control pushes and clean up on interrupt`, async ({
		page,
	}) => {
		const control = await mockWsRpc(
			page,
			typed
				? {
						stubs: { SubscribeInputDraft: () => Stream.never },
					}
				: {},
		);
		await openClient(page);
		const pending = page.evaluate(
			(take) =>
				window.callRpc(
					"SubscribeInputDraft",
					{
						projectSlug: "p",
						sessionId: "s",
					},
					take,
				),
			typed ? 1 : 2,
		);
		await expect
			.poll(() => control.hasStream("SubscribeInputDraft", "s"))
			.toBe(true);
		control.sendInputDraft("s", { text: "Queued draft", from: "another-tab" });
		expect(await pending).toEqual({
			value: [
				...(typed ? [] : [{ _tag: "synchronized" }]),
				{ _tag: "draft", text: "Queued draft", from: "another-tab" },
			],
		});
		await expect
			.poll(() => control.hasStream("SubscribeInputDraft", "s"))
			.toBe(false);
	});
}

test("a control helper fails a typed stream with its declared error", async ({
	page,
}) => {
	const control = await mockWsRpc(page, {
		stubs: { SubscribeInputDraft: () => Stream.never },
	});
	await openClient(page);
	const pending = page.evaluate(() =>
		window.callRpc("SubscribeInputDraft", { projectSlug: "p", sessionId: "s" }),
	);
	await expect
		.poll(() => control.hasStream("SubscribeInputDraft", "s"))
		.toBe(true);
	control.failStream("SubscribeInputDraft", "refused", "s");
	expect(await pending).toEqual({
		error: { _tag: "WsRpcError", message: "refused" },
		isInstance: true,
	});
	expect(control.hasStream("SubscribeInputDraft", "s")).toBe(false);
});

test("an invalid typed stream chunk fails its owning spec", async ({
	page,
}) => {
	await mockWsRpc(page, {
		stubs: {
			// @ts-expect-error Exercise stale stream fixtures at runtime.
			SubscribeInputDraft: () => Stream.make({ _tag: "draft", text: 42 }),
		},
	});
	await openClient(page);
	await page.evaluate(() =>
		window.callRpc(
			"SubscribeInputDraft",
			{ projectSlug: "p", sessionId: "s" },
			1,
		),
	);
	test.fail(
		true,
		"The mock must record the invalid typed chunk as a spec failure",
	);
});

test("an invalid typed stream failure fails its owning spec", async ({
	page,
}) => {
	await mockWsRpc(page, {
		stubs: {
			// @ts-expect-error Exercise an invalid declared stream failure at runtime.
			SubscribeInputDraft: () =>
				Stream.fail({ _tag: "WsRpcError", message: 42 }),
		},
	});
	await openClient(page);
	await page.evaluate(() =>
		window.callRpc("SubscribeInputDraft", { projectSlug: "p", sessionId: "s" }),
	);
	test.fail(
		true,
		"The mock must record the invalid declared failure as a spec failure",
	);
});
