// conduit-test-whn9: a rewind far below the loaded page must refill the visible
// transcript, page every predecessor once, and restore all 200 messages on undo.
// Failure modes: hidden rows survive, the pre-cut page is empty or incomplete,
// older-page cursors skip/repeat rows, ordering changes, or undo duplicates rows.
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import type {
	CanonicalEvent,
	EventPayloadMap,
	LiveEventType,
} from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const SESSION = "deep-rewind";
const COUNT = 200;
const messageId = (index: number) =>
	`${SESSION}-${String(index).padStart(3, "0")}`;
const allIds = Array.from({ length: COUNT }, (_, index) => messageId(index));

const seed = (filename: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const start = Date.UTC(2026, 9, 1);
			const event = <T extends LiveEventType>(
				index: number,
				type: T,
				data: EventPayloadMap[T],
			) =>
				canonicalEvent(type, SESSION, data, {
					provider: "claude",
					createdAt: start + index * 1000,
				});
			const messages: CanonicalEvent[] = allIds.flatMap((id, index) => [
				event(index + 1, "message.created", {
					messageId: id,
					role: index % 2 === 0 ? "user" : "assistant",
					sessionId: SESSION,
				}),
				event(index + 1, "text.delta", {
					messageId: id,
					partId: `${id}-text`,
					text: `Message ${String(index).padStart(3, "0")}.`,
				}),
				...(index % 2 === 0
					? []
					: [
							event(index + 1, "turn.completed", {
								messageId: id,
								tokens: { input: 10, output: 10 },
								duration: 1000,
							}),
						]),
			]);
			yield* commit(
				[
					event(0, "session.created", {
						sessionId: SESSION,
						title: "Deep rewind paging",
						provider: "claude",
						providerSessionId: SESSION,
					}),
					...messages,
				],
				{ publish: false },
			);
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "process-test")),
		),
	);

const find = (value: unknown, match: (value: object) => boolean): object[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap((child) => find(child, match));
	return match(value) ? [value, ...nested] : nested;
};

test.describe.configure({ retries: 0 });

test("deep rewind pages every older message once and undo restores the transcript", async ({
	browser,
	harness,
	isMobile,
}, testInfo) => {
	test.setTimeout(240_000);
	await harness.terminate();
	await seed(harness.projectStorePath());
	await harness.restart({ keepPort: true, skipBrowserProbe: true });
	const control = await harness.connect(
		undefined,
		undefined,
		"process-test",
		false,
	);
	const scenarios: Record<string, unknown>[] = [];
	const report = {
		bead: "conduit-test-whn9",
		project: testInfo.project.name,
		seededIds: allIds,
		scenarios,
	};
	try {
		// Cut 20 is the requested early rewind. Cut 80 leaves more than one
		// 50-message page, so it also proves scrolling performs real older reads.
		for (const cut of [20, 80]) {
			const context = await browser.newContext({
				viewport: testInfo.project.use.viewport ?? null,
				isMobile,
				hasTouch: isMobile,
			});
			const page = await context.newPage();
			const pageErrors: string[] = [];
			const olderPages: { ids: string[]; hasMore: boolean }[] = [];
			const scenario: Record<string, unknown> = {
				cut,
				cutId: messageId(cut),
				expectedBeforeCut: allIds.slice(0, cut),
				pageErrors,
				olderPages,
			};
			scenarios.push(scenario);
			page.on("pageerror", (error) => pageErrors.push(error.message));
			page.on("websocket", (socket) => {
				if (new URL(socket.url()).pathname !== "/rpc") return;
				socket.on("framereceived", ({ payload }) => {
					const value: unknown = JSON.parse(payload.toString());
					for (const response of find(
						value,
						(found) =>
							"sessionId" in found &&
							found.sessionId === SESSION &&
							"messages" in found &&
							Array.isArray(found.messages) &&
							"hasMore" in found,
					)) {
						if (!("messages" in response) || !Array.isArray(response.messages))
							continue;
						olderPages.push({
							ids: response.messages.map((message: unknown) =>
								typeof message === "object" &&
								message !== null &&
								"id" in message &&
								typeof message.id === "string"
									? message.id
									: "",
							),
							hasMore: "hasMore" in response && response.hasMore === true,
						});
					}
				});
			});
			try {
				const app = new AppPage(page);
				const ids = () =>
					app.messages
						.locator(".msg-user, .msg-assistant")
						.evaluateAll((messages) =>
							messages.map(
								(message) =>
									message.getAttribute("data-uuid")?.split("/")[0] ?? null,
							),
						);
				await app.goto(`${harness.baseUrl}/s/${SESSION}?p=process-test`);
				await expect.poll(ids, { timeout: 30_000 }).toEqual(allIds.slice(-50));
				scenario["initialPage"] = await ids();
				const pagesFrom = olderPages.length;
				await Effect.runPromise(
					control.rpc.RewindSession({
						sessionId: SESSION,
						messageId: messageId(cut),
					}),
				);
				await expect(page.getByTestId("rewind-pending")).toBeVisible({
					timeout: 30_000,
				});
				await expect
					.poll(ids)
					.toEqual(allIds.slice(Math.max(0, cut - 50), cut));
				scenario["rewoundPage"] = await ids();
				// Exact ids assert every row at/after the cut is absent, and the
				// messages immediately before it are present in order, once each.
				const scrollToAll = async (expected: readonly string[]) => {
					await expect(async () => {
						await app.messages.evaluate((messages) => {
							messages.scrollTop = 0;
						});
						await expect.poll(ids, { timeout: 1000 }).toEqual(expected);
					}).toPass({ timeout: 60_000 });
				};
				await scrollToAll(allIds.slice(0, cut));
				scenario["afterScroll"] = await ids();
				const rewindPages = olderPages.slice(pagesFrom);
				scenario["rewindOlderPages"] = rewindPages;
				if (cut > 50) {
					expect(rewindPages.length).toBeGreaterThan(0);
					expect(rewindPages.flatMap(({ ids }) => ids)).toEqual(
						allIds.slice(0, cut - 50),
					);
					expect(rewindPages.at(-1)?.hasMore).toBe(false);
				}
				await Effect.runPromise(
					control.rpc.UndoRewind({
						sessionId: SESSION,
					}),
				);
				await expect(page.getByTestId("rewind-pending")).toBeHidden({
					timeout: 30_000,
				});
				await expect(app.messages).toContainText("Message 199.");
				await scrollToAll(allIds);
				scenario["afterUndo"] = await ids();
				expect(pageErrors).toEqual([]);
				scenario["assertionsPassed"] = true;
			} finally {
				await context.close();
			}
		}
	} finally {
		const output = testInfo.outputPath("deep-rewind.json");
		writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
		await testInfo.attach("deep-rewind", {
			path: output,
			contentType: "application/json",
		});
	}
});
