// conduit-test-mryl.6: recoverable attachment failures through a real daemon.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import type { Page, WebSocketRoute } from "@playwright/test";
import { Effect, Layer, Option, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import type { InputDraftKey } from "../../../src/lib/contracts/ws-rpc.js";
import { assertAttachmentCatalogue } from "../../helpers/attachment-catalogue.js";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { claudeModels, pickClaudeModel } from "../helpers/draft-model.js";
import {
	expect,
	test as harnessTest,
} from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const imageBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
	"base64",
);
const image = {
	name: "failure-pixel.png",
	mimeType: "image/png",
	buffer: imageBytes,
};
const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
const chips = (page: Page) => page.getByTestId("draft-attachment");
const draftRoute = (id: string) => `/draft/${id}?p=process-test`;

type Frame = {
	id?: string | number;
	requestId?: string | number;
	tag?: string;
	_tag?: string;
	payload?: Record<string, unknown>;
	exit?: { _tag: string; value?: unknown };
};

// Keep the real protocol and server. Only the selected frames are delayed,
// dropped, or changed, so failures have explicit RPC and durable checkpoints.
async function interceptDraftRpc(page: Page) {
	const wire = {
		online: true,
		holdAdds: false,
		holdSubmitReplies: false,
		dropAddReplies: false,
		suppressSnapshots: false,
		snapshots: 0,
		connections: [] as WebSocketRoute[],
		requests: [] as Frame[],
		replies: [] as { tag: string; frame: Frame }[],
		held: [] as { frame: Frame; send: () => void }[],
		heldSubmitReplies: [] as { frame: Frame; send: () => void }[],
		rewrite: (frame: Frame): Frame => frame,
		onReply: (_tag: string, _frame: Frame): void => {},
	};
	await page.routeWebSocket(/\/rpc$/, async (client) => {
		if (!wire.online) {
			await client.close({
				code: 1012,
				reason: "Draft attachment test outage",
			});
			return;
		}
		wire.connections.push(client);
		const server = client.connectToServer();
		const tags = new Map<string, string>();
		client.onMessage((message) => {
			const original = JSON.parse(message.toString()) as Frame;
			const frame = wire.rewrite(original);
			wire.requests.push(frame);
			if (frame.id !== undefined && frame.tag)
				tags.set(String(frame.id), frame.tag);
			const send = () => server.send(JSON.stringify(frame));
			if (wire.holdAdds && frame.tag === "AddDraftAttachment")
				wire.held.push({ frame, send });
			else send();
		});
		server.onMessage((message) => {
			const frame = JSON.parse(message.toString()) as Frame;
			const tag = tags.get(String(frame.requestId)) ?? "";
			wire.replies.push({ tag, frame });
			wire.onReply(tag, frame);
			if (
				tag === "input.submit" &&
				frame._tag === "Exit" &&
				wire.holdSubmitReplies
			) {
				wire.heldSubmitReplies.push({
					frame,
					send: () => client.send(message),
				});
				return;
			}
			if (tag === "AddDraftAttachment" && wire.dropAddReplies) return;
			if (tag === "SubscribeInputDraft") {
				if (wire.suppressSnapshots) return;
				if (frame._tag === "Chunk") wire.snapshots++;
			}
			client.send(message);
		});
	});
	return wire;
}

async function disconnect(
	page: Page,
	wire: Awaited<ReturnType<typeof interceptDraftRpc>>,
) {
	wire.online = false;
	await Promise.all(
		wire.connections.splice(0).map((client) =>
			client.close({
				code: 1012,
				reason: "Draft attachment test disconnect",
			}),
		),
	);
	await expect(page.locator("#connect-overlay")).toBeVisible();
}

async function reconnect(
	page: Page,
	wire: Awaited<ReturnType<typeof interceptDraftRpc>>,
) {
	const before = wire.snapshots;
	wire.online = true;
	await expect
		.poll(() => wire.snapshots, { timeout: 30_000 })
		.toBeGreaterThan(before);
	await expect(page.locator("#connect-overlay")).toBeHidden();
}

function storedDraft(harness: ProcessHarness, key: string) {
	const db = new DatabaseSync(harness.daemonStorePath(), { timeout: 5_000 });
	try {
		return {
			draft: db
				.prepare(
					"SELECT text, promoted_session_id FROM input_drafts WHERE draft_key = ?",
				)
				.get(key),
			attachments: db
				.prepare(
					"SELECT id, name, hash, state FROM draft_attachments WHERE draft_key = ? ORDER BY position, id",
				)
				.all(key),
			admitted: db
				.prepare("SELECT event_id FROM events WHERE type = 'input.admitted'")
				.all(),
		};
	} finally {
		db.close();
	}
}

async function snapshot(browser: ProcessBrowser, key: InputDraftKey) {
	return Option.getOrThrow(
		await Effect.runPromise(
			browser.rpc
				.SubscribeInputDraft({ key })
				.pipe(Stream.runHead, Effect.timeout("10 seconds")),
		),
	);
}

async function add(
	browser: ProcessBrowser,
	key: InputDraftKey,
	id = randomUUID(),
) {
	await Effect.runPromise(
		browser.rpc.AddDraftAttachment({
			key,
			id,
			name: image.name,
			mime: "image/png",
			dataUrl,
			projectSlug: "process-test",
		}),
	);
	return id;
}

async function pick(page: Page) {
	await page.locator("input[type=file]").last().setInputFiles(image);
}

const test = harnessTest.extend<{ report: Record<string, unknown> }>({
	report: [
		async ({ harness }, use, testInfo) => {
			const report: Record<string, unknown> = {
				bead: "conduit-test-mryl.6",
				test: testInfo.title,
				project: testInfo.project.name,
				passed: false,
			};
			const directory = "test-results/draft-attachments";
			mkdirSync(directory, { recursive: true });
			const path = join(
				directory,
				`mryl-6-${testInfo.project.name}-${testInfo.testId}.json`,
			);
			writeFileSync(path, JSON.stringify(report, null, 2));
			try {
				await use(report);
			} finally {
				const catalogue = await Effect.runPromise(
					assertAttachmentCatalogue.pipe(
						Effect.provide(
							SqliteNode.layer({
								filename: harness.daemonStorePath(),
								readonly: true,
							}).pipe(Layer.provide(Reactivity.layer)),
						),
						Effect.scoped,
					),
				);
				report["catalogueViolations"] = catalogue;
				report["logTail"] = harness.logTail.slice(-3000);
				report["passed"] =
					testInfo.status === "passed" && catalogue.length === 0;
				writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
				await testInfo.attach("draft-attachment-failure-result", {
					path,
					contentType: "application/json",
				});
				expect(catalogue).toEqual([]);
			}
		},
		{ auto: true },
	],
});
test.use({
	harnessOptions: { restartProof: true, capabilityModels: claudeModels },
});
test.describe.configure({ retries: 0, timeout: 120_000 });

test("an offline Add is not saved and reconnect saves the same id", async ({
	harness,
	page,
	report,
}) => {
	const draftId = randomUUID();
	const wire = await interceptDraftRpc(page);
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}${draftRoute(draftId)}`);
	await expect.poll(() => wire.snapshots).toBeGreaterThan(0);
	await disconnect(page, wire);
	await pick(page);
	await expect(chips(page)).toHaveAttribute("data-status", "failed");
	await expect(chips(page)).toContainText("not saved");
	const id = await chips(page).getAttribute("data-attachment-id");
	expect(storedDraft(harness, draftId).attachments).toEqual([]);
	await reconnect(page, wire);
	await expect(chips(page)).toHaveAttribute("data-status", "saved");
	await expect
		.poll(() => storedDraft(harness, draftId).attachments)
		.toContainEqual(expect.objectContaining({ id, state: "live" }));
	report["attachmentId"] = id;
	report["draft"] = storedDraft(harness, draftId);
});

test("saving and failed chips block both Send and Control+Enter", async ({
	harness,
	page,
	report,
}) => {
	const draftId = randomUUID();
	const wire = await interceptDraftRpc(page);
	wire.holdAdds = true;
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}${draftRoute(draftId)}`);
	await pickClaudeModel(page);
	await app.input.fill("Keep this text while the attachment saves");
	await expect
		.poll(() => storedDraft(harness, draftId).draft?.["text"])
		.toBe("Keep this text while the attachment saves");
	await pick(page);
	await expect.poll(() => wire.held.length).toBe(1);
	await expect(chips(page)).toHaveAttribute("data-status", "saving");
	await expect(app.sendBtn).toBeDisabled();
	await app.input.press("Control+Enter");
	await disconnect(page, wire);
	await expect(chips(page)).toHaveAttribute("data-status", "failed");
	await expect(app.sendBtn).toBeDisabled();
	// The disconnected overlay intentionally covers the composer. A keyboard
	// event still probes the composer's own send guard on every viewport.
	await app.input.dispatchEvent("keydown", {
		key: "Enter",
		code: "Enter",
		ctrlKey: true,
		bubbles: true,
	});
	wire.holdAdds = false;
	await reconnect(page, wire);
	await expect(chips(page)).toHaveAttribute("data-status", "saved");
	await expect(app.sendBtn).toBeEnabled();
	expect(
		wire.requests.filter(
			(frame) => frame.tag === "input.submit" || frame.tag === "CreateSession",
		),
	).toEqual([]);
	expect(storedDraft(harness, draftId).admitted).toEqual([]);
	await expect(app.input).toHaveValue(
		"Keep this text while the attachment saves",
	);
	report["draft"] = storedDraft(harness, draftId);
	report["addIds"] = wire.requests
		.filter((frame) => frame.tag === "AddDraftAttachment")
		.map((frame) => frame.payload?.["id"]);
});

test("Retry resends the same item and a refused Remove restores its saved state with an error", async ({
	harness,
	page,
	report,
}) => {
	const draftId = randomUUID();
	const wire = await interceptDraftRpc(page);
	const refused = new Set<string>();
	wire.rewrite = (frame) => {
		if (
			(frame.tag === "AddDraftAttachment" ||
				frame.tag === "RemoveDraftAttachment") &&
			!refused.has(frame.tag)
		) {
			refused.add(frame.tag);
			const payload = { ...frame.payload };
			delete payload["projectSlug"];
			return { ...frame, payload };
		}
		return frame;
	};
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}${draftRoute(draftId)}`);
	await pickClaudeModel(page);
	await app.input.fill("Keep this text until Retry saves the attachment");
	await pick(page);
	await expect(chips(page)).toHaveAttribute("data-status", "failed");
	await expect(chips(page)).toContainText("not saved");
	await expect(chips(page).getByTestId("draft-attachment-error")).toContainText(
		"projectSlug is required",
	);
	const id = await chips(page).getAttribute("data-attachment-id");
	await expect(app.sendBtn).toBeDisabled();
	wire.holdAdds = true;
	await chips(page).getByRole("button", { name: "Retry", exact: true }).click();
	await expect.poll(() => wire.held.length).toBe(1);
	await expect(chips(page)).toHaveAttribute("data-status", "saving");
	await expect(app.sendBtn).toBeDisabled();
	await app.input.press("Control+Enter");
	const retry = wire.held[0];
	if (!retry) throw new Error("Retry did not resend its Add");
	wire.holdAdds = false;
	retry.send();
	await expect(chips(page)).toHaveAttribute("data-status", "saved");
	await expect(app.sendBtn).toBeEnabled();
	await expect(app.input).toHaveValue(
		"Keep this text until Retry saves the attachment",
	);
	expect(
		wire.requests.filter((frame) => frame.tag === "CreateSession"),
	).toEqual([]);
	expect(storedDraft(harness, draftId).admitted).toEqual([]);
	const addIds = wire.requests
		.filter((frame) => frame.tag === "AddDraftAttachment")
		.map((frame) => frame.payload?.["id"]);
	expect(addIds).toEqual([id, id]);
	await chips(page)
		.getByRole("button", { name: `Remove image ${image.name}`, exact: true })
		.click();
	await expect
		.poll(
			() =>
				wire.replies.filter(
					({ tag, frame }) =>
						tag === "RemoveDraftAttachment" && frame._tag === "Exit",
				).length,
		)
		.toBe(1);
	await expect(chips(page)).toHaveAttribute("data-status", "saved");
	await expect(chips(page).getByTestId("draft-attachment-error")).toContainText(
		"projectSlug is required",
	);
	expect(storedDraft(harness, draftId).attachments).toContainEqual(
		expect.objectContaining({ id, state: "live" }),
	);
	await chips(page)
		.getByRole("button", { name: `Remove image ${image.name}`, exact: true })
		.click();
	await expect(chips(page)).toHaveCount(0);
	await expect
		.poll(() => storedDraft(harness, draftId).attachments)
		.toContainEqual(
			expect.objectContaining({ id, state: "removed", hash: null }),
		);
	report["addIds"] = addIds;
	report["draft"] = storedDraft(harness, draftId);
});

test("a refused Remove restores a failed chip and a second Remove drops it", async ({
	harness,
	page,
	report,
}) => {
	const draftId = randomUUID();
	const wire = await interceptDraftRpc(page);
	let rejectRemove = true;
	wire.rewrite = (frame) => {
		if (
			frame.tag === "AddDraftAttachment" ||
			(frame.tag === "RemoveDraftAttachment" && rejectRemove)
		) {
			if (frame.tag === "RemoveDraftAttachment") rejectRemove = false;
			const payload = { ...frame.payload };
			delete payload["projectSlug"];
			return { ...frame, payload };
		}
		return frame;
	};
	await new AppPage(page).goto(`${harness.baseUrl}${draftRoute(draftId)}`);
	await pick(page);
	await expect(chips(page)).toHaveAttribute("data-status", "failed");
	const id = await chips(page).getAttribute("data-attachment-id");
	await chips(page)
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	await expect
		.poll(
			() =>
				wire.replies.filter(
					({ tag, frame }) =>
						tag === "RemoveDraftAttachment" && frame._tag === "Exit",
				).length,
		)
		.toBe(1);
	await expect(chips(page)).toHaveAttribute("data-status", "failed");
	await expect(chips(page)).toContainText("not saved");
	await expect(chips(page).getByTestId("draft-attachment-error")).toContainText(
		"projectSlug is required",
	);
	await chips(page)
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	await expect(chips(page)).toHaveCount(0);
	await expect
		.poll(() => storedDraft(harness, draftId).attachments)
		.toContainEqual(
			expect.objectContaining({ id, state: "removed", hash: null }),
		);
	report["attachmentId"] = id;
	report["draft"] = storedDraft(harness, draftId);
});

test("reloading before reconnect drops a local-only failed attachment", async ({
	harness,
	page,
	report,
}) => {
	const draftId = randomUUID();
	const wire = await interceptDraftRpc(page);
	await new AppPage(page).goto(`${harness.baseUrl}${draftRoute(draftId)}`);
	await disconnect(page, wire);
	await pick(page);
	await expect(chips(page)).toHaveAttribute("data-status", "failed");
	const id = await chips(page).getAttribute("data-attachment-id");
	await page.reload();
	await expect(new AppPage(page).layout).toBeAttached();
	await reconnect(page, wire);
	await expect(chips(page)).toHaveCount(0);
	expect(
		wire.requests.filter((frame) => frame.tag === "AddDraftAttachment"),
	).toEqual([]);
	expect(storedDraft(harness, draftId).attachments).toEqual([]);
	report["lostLocalId"] = id;
	report["draft"] = storedDraft(harness, draftId);
});

for (const refusal of [
	{
		name: "over 5 MB",
		mime: "image/png",
		data: () =>
			`data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString("base64")}`,
		message: "The file is over the 5 MB attachment limit.",
	},
	{
		name: "disallowed MIME",
		mime: "application/zip",
		data: () => `data:application/zip;base64,${imageBytes.toString("base64")}`,
		message:
			"Claude and OpenCode both accept plain text, PDF, PNG, JPEG, GIF and WebP.",
	},
] as const) {
	test(`the server refuses ${refusal.name} with a typed message and reconnect does not retry it`, async ({
		harness,
		page,
		report,
	}) => {
		const control = await harness.connect();
		const draftId = randomUUID();
		const invalidDataUrl = refusal.data();
		const result = await Effect.runPromise(
			control.rpc
				.AddDraftAttachment({
					key: { draft: draftId },
					id: randomUUID(),
					name: image.name,
					mime: refusal.mime,
					dataUrl: invalidDataUrl,
					projectSlug: "process-test",
				})
				.pipe(Effect.result),
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "DraftAttachmentRejected", message: refusal.message },
		});
		const wire = await interceptDraftRpc(page);
		// A normal pick passes the browser's shrink/filter path. Change only the
		// wire payload to prove the daemon enforces its own limits through put.
		wire.rewrite = (frame) =>
			frame.tag === "AddDraftAttachment"
				? {
						...frame,
						payload: {
							...frame.payload,
							mime: refusal.mime,
							dataUrl: invalidDataUrl,
						},
					}
				: frame;
		await new AppPage(page).goto(`${harness.baseUrl}${draftRoute(draftId)}`);
		await pick(page);
		await expect(chips(page)).toHaveAttribute("data-status", "failed");
		await expect(chips(page).getByTestId("draft-attachment-error")).toHaveText(
			refusal.message,
		);
		await expect(new AppPage(page).sendBtn).toBeDisabled();
		expect(
			JSON.stringify(
				wire.replies.filter(({ tag }) => tag === "AddDraftAttachment"),
			),
		).toContain("DraftAttachmentRejected");
		await disconnect(page, wire);
		await reconnect(page, wire);
		const autosave = `Still here after reconnect: ${refusal.name}`;
		await new AppPage(page).input.fill(autosave);
		await expect
			.poll(() => storedDraft(harness, draftId).draft?.["text"])
			.toBe(autosave);
		await expect(chips(page)).toHaveAttribute("data-status", "failed");
		await expect(chips(page).getByTestId("draft-attachment-error")).toHaveText(
			refusal.message,
		);
		expect(
			wire.requests.filter((frame) => frame.tag === "AddDraftAttachment"),
		).toHaveLength(1);
		expect(storedDraft(harness, draftId).attachments).toEqual([]);
		report["refusal"] = {
			tag: "DraftAttachmentRejected",
			message: refusal.message,
		};
		report["draft"] = storedDraft(harness, draftId);
	});
}

test("DraftAttachmentMissing preserves the composer, shows the error and refreshes the server snapshot", async ({
	harness,
	page,
	report,
}) => {
	const control = await harness.connect();
	const sessionId = await control.createSession(
		"Missing Draft attachment on Send",
	);
	const key = { session: sessionId };
	const removedId = await add(control, key);
	const keptId = await add(control, key);
	const text = "Keep this text after a refused attachment send";
	await Effect.runPromise(
		control.rpc.SyncInputDraft({
			key,
			text,
			originId: control.originId,
			projectSlug: "process-test",
		}),
	);
	const wire = await interceptDraftRpc(page);
	wire.onReply = (tag, frame) => {
		if (
			tag === "input.submit" &&
			frame._tag === "Exit" &&
			JSON.stringify(frame).includes("DraftAttachmentMissing")
		)
			wire.suppressSnapshots = false;
	};
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
	await expect(app.input).toHaveValue(text);
	await expect(chips(page)).toHaveCount(2);
	wire.suppressSnapshots = true;
	await Effect.runPromise(
		control.rpc.RemoveDraftAttachment({
			key,
			id: removedId,
			projectSlug: "process-test",
		}),
	);
	const newId = await add(control, key);
	await expect(chips(page)).toHaveCount(2);
	const beforeSnapshots = wire.snapshots;
	await expect(app.sendBtn).toBeEnabled();
	await app.input.press("Control+Enter");
	await expect
		.poll(() =>
			JSON.stringify(wire.replies.filter(({ tag }) => tag === "input.submit")),
		)
		.toContain("DraftAttachmentMissing");
	await expect(app.input).toHaveValue(text);
	await expect(page.getByTestId("attachment-error")).toContainText(
		"A Draft attachment was removed",
	);
	await expect.poll(() => wire.snapshots).toBeGreaterThan(beforeSnapshots);
	await expect(chips(page)).toHaveCount(2);
	await expect(
		page.locator(
			`[data-testid='draft-attachment'][data-attachment-id='${removedId}']`,
		),
	).toHaveCount(0);
	await expect(
		page.locator(
			`[data-testid='draft-attachment'][data-attachment-id='${keptId}']`,
		),
	).toHaveAttribute("data-status", "saved");
	await expect(
		page.locator(
			`[data-testid='draft-attachment'][data-attachment-id='${newId}']`,
		),
	).toHaveAttribute("data-status", "saved");
	expect(storedDraft(harness, sessionId).admitted).toEqual([]);
	expect(storedDraft(harness, sessionId).draft?.["text"]).toBe(text);
	report["sendResponse"] = wire.replies.filter(
		({ tag }) => tag === "input.submit",
	);
	report["snapshot"] = await snapshot(control, key);
	report["draft"] = storedDraft(harness, sessionId);
});

test("a delayed missing-attachment failure refreshes its original key without changing another session's composer", async ({
	harness,
	page,
	report,
}) => {
	const control = await harness.connect();
	const first = await control.createSession(
		"Delayed missing attachment origin",
	);
	const second = await control.createSession(
		"Composer while another send fails",
	);
	const firstKey = { session: first };
	const secondKey = { session: second };
	const firstText = "This belongs to the send whose response is delayed";
	const secondText = "This belongs to the other session's composer";
	const removedId = await add(control, firstKey);
	const secondId = await add(control, secondKey);
	for (const [key, text] of [
		[firstKey, firstText],
		[secondKey, secondText],
	] as const) {
		await Effect.runPromise(
			control.rpc.SyncInputDraft({
				key,
				text,
				originId: control.originId,
				projectSlug: "process-test",
			}),
		);
	}
	const wire = await interceptDraftRpc(page);
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/s/${first}?p=process-test`);
	await expect(app.input).toHaveValue(firstText);
	await expect(chips(page)).toHaveAttribute("data-attachment-id", removedId);
	wire.suppressSnapshots = true;
	wire.holdSubmitReplies = true;
	await Effect.runPromise(
		control.rpc.RemoveDraftAttachment({
			key: firstKey,
			id: removedId,
			projectSlug: "process-test",
		}),
	);
	await expect(app.sendBtn).toBeEnabled();
	await app.input.press("Control+Enter");
	await expect.poll(() => wire.heldSubmitReplies.length).toBe(1);
	const response = wire.heldSubmitReplies[0];
	if (!response) throw new Error("Missing-attachment failure was not held");
	expect(JSON.stringify(response.frame)).toContain("DraftAttachmentMissing");
	expect(storedDraft(harness, first).admitted).toEqual([]);
	wire.suppressSnapshots = false;
	// A real SPA route change preserves the composer component and outstanding RPC.
	await page.evaluate((path) => {
		history.pushState({}, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, `/s/${second}?p=process-test`);
	await expect(page).toHaveURL(new RegExp(`/s/${second}\\?`));
	await expect(app.input).toHaveValue(secondText);
	await expect(chips(page)).toHaveAttribute("data-attachment-id", secondId);
	const beforeRefresh = wire.requests.filter(
		(frame) =>
			frame.tag === "SubscribeInputDraft" &&
			JSON.stringify(frame.payload?.["key"]) === JSON.stringify(firstKey),
	).length;
	wire.holdSubmitReplies = false;
	response.send();
	await expect
		.poll(
			() =>
				wire.requests.filter(
					(frame) =>
						frame.tag === "SubscribeInputDraft" &&
						JSON.stringify(frame.payload?.["key"]) === JSON.stringify(firstKey),
				).length,
		)
		.toBe(beforeRefresh + 1);
	const refresh = wire.requests
		.filter(
			(frame) =>
				frame.tag === "SubscribeInputDraft" &&
				JSON.stringify(frame.payload?.["key"]) === JSON.stringify(firstKey),
		)
		.at(-1);
	if (!refresh)
		throw new Error("The failed send did not refresh its original Draft key");
	await expect
		.poll(
			() =>
				wire.replies.filter(
					({ tag, frame }) =>
						tag === "SubscribeInputDraft" &&
						String(frame.requestId) === String(refresh.id) &&
						frame._tag === "Chunk",
				).length,
		)
		.toBeGreaterThan(0);
	await expect(app.input).toHaveValue(secondText);
	const editedSecondText = `${secondText}; edited after the old key refreshed`;
	await app.input.fill(editedSecondText);
	await expect
		.poll(() => storedDraft(harness, second).draft?.["text"])
		.toBe(editedSecondText);
	await expect(page.getByTestId("attachment-error")).toHaveCount(0);
	await expect(chips(page)).toHaveAttribute("data-attachment-id", secondId);
	await expect(chips(page)).toHaveAttribute("data-status", "saved");
	expect(storedDraft(harness, first).draft?.["text"]).toBe(firstText);
	expect(storedDraft(harness, first).attachments).toContainEqual(
		expect.objectContaining({ id: removedId, state: "removed", hash: null }),
	);
	report["delayedSendResponse"] = response.frame;
	report["refreshedKey"] = firstKey;
	report["refreshRequestId"] = refresh.id;
	report["originalDraft"] = storedDraft(harness, first);
	report["currentDraft"] = storedDraft(harness, second);
});

for (const ended of ["removed", "sent"] as const) {
	test(`a committed Add with a dropped ack retried after another browser ${ended} it disappears silently`, async ({
		harness,
		page,
		browser,
		report,
	}) => {
		const control = await harness.connect();
		const sessionId = await control.createSession(
			`Lost Add acknowledgment ${ended}`,
		);
		const wire = await interceptDraftRpc(page);
		await new AppPage(page).goto(
			`${harness.baseUrl}/s/${sessionId}?p=process-test`,
		);
		await expect.poll(() => wire.snapshots).toBeGreaterThan(0);
		const other = await browser.newContext({
			viewport: page.viewportSize() ?? { width: 1440, height: 900 },
		});
		try {
			const tabB = await other.newPage();
			const appB = new AppPage(tabB);
			await appB.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
			wire.dropAddReplies = true;
			wire.suppressSnapshots = true;
			await pick(page);
			await expect(chips(page)).toHaveAttribute("data-status", "saving");
			await expect(chips(tabB)).toHaveAttribute("data-status", "saved");
			const id = await chips(page).getAttribute("data-attachment-id");
			await expect
				.poll(() => storedDraft(harness, sessionId).attachments)
				.toContainEqual(expect.objectContaining({ id, state: "live" }));
			await expect
				.poll(
					() =>
						wire.replies.filter(
							({ tag, frame }) =>
								tag === "AddDraftAttachment" && frame._tag === "Exit",
						).length,
				)
				.toBe(1);
			if (ended === "removed")
				await chips(tabB)
					.getByRole("button", {
						name: `Remove image ${image.name}`,
						exact: true,
					})
					.click();
			else {
				await appB.input.fill(
					"Send the attachment whose other Add acknowledgment was lost",
				);
				await expect(appB.sendBtn).toBeEnabled();
				await appB.input.press("Control+Enter");
			}
			await expect(chips(tabB)).toHaveCount(0);
			await expect
				.poll(() => storedDraft(harness, sessionId).attachments)
				.toContainEqual(
					expect.objectContaining({ id, state: ended, hash: null }),
				);
			await disconnect(page, wire);
			await expect(chips(page)).toHaveAttribute("data-status", "failed");
			wire.dropAddReplies = false;
			wire.suppressSnapshots = false;
			await reconnect(page, wire);
			await expect
				.poll(() =>
					JSON.stringify(
						wire.replies.filter(({ tag }) => tag === "AddDraftAttachment"),
					),
				)
				.toContain(`"ended":"${ended}"`);
			await expect(chips(page)).toHaveCount(0);
			await expect(page.getByTestId("draft-attachment-error")).toHaveCount(0);
			await expect(page.getByTestId("attachment-error")).toHaveCount(0);
			await expect(page.getByText("not saved", { exact: true })).toHaveCount(0);
			const addIds = wire.requests
				.filter((frame) => frame.tag === "AddDraftAttachment")
				.map((frame) => frame.payload?.["id"]);
			expect(addIds).toEqual([id, id]);
			report["addIds"] = addIds;
			report["addResponses"] = wire.replies.filter(
				({ tag }) => tag === "AddDraftAttachment",
			);
			report["draft"] = storedDraft(harness, sessionId);
		} finally {
			await other.close();
		}
	});
}
