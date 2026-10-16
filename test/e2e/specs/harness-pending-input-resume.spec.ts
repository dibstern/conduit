// conduit-test-whn9: a queued input consumed while the browser is disconnected
// must leave the tray on resume and occur exactly once in the transcript.
// Failure modes: premature consumption, reconnecting before consumption, a
// snapshot hiding stale held rows, a lingering tray entry, or a repeated turn.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebSocketRoute } from "@playwright/test";
import { Effect } from "effect";
import { responseChunks } from "../../helpers/fake-claude-process-sdk.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test.use({ harnessOptions: { restartProof: true } });
test.describe.configure({ retries: 0 });

const find = (value: unknown, match: (value: object) => boolean): object[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap((child) => find(child, match));
	return match(value) ? [value, ...nested] : nested;
};

test("resume removes an input consumed while the browser was disconnected", async ({
	harness,
	page,
}, testInfo) => {
	test.setTimeout(180_000);
	const browser = await harness.connect();
	const sessionId = await browser.createSession(
		"Consumed pending input resume",
	);
	const foreground = "task-stop-foreground-pending-resume";
	const queued = "pending-resume-consumed-input";
	const expectedTranscript = [
		foreground,
		responseChunks(foreground).join(""),
		queued,
		responseChunks(queued).join(""),
	];
	const inputId = randomUUID();
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	const sent: unknown[] = [];
	const received: unknown[] = [];
	const pageErrors: string[] = [];
	let mismatches = 0;
	let offline = false;
	const connections: WebSocketRoute[] = [];
	const report: Record<string, unknown> = {
		bead: "conduit-test-whn9",
		project: testInfo.project.name,
		sessionId,
		inputId,
		foreground,
		queued,
		expectedTranscript,
		assertionsPassed: false,
	};
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.text().includes("[resume] checksum mismatch")) mismatches++;
	});
	// Pass through real RPC. The outage closes the browser's sockets, so the
	// client sees a real disconnect rather than silently lost messages.
	// Retry connections stay closed until the server has consumed the input.
	await page.routeWebSocket(
		(url) => url.pathname === "/rpc",
		async (client) => {
			if (offline) {
				await client.close({ code: 1012, reason: "Test browser outage" });
				return;
			}
			const server = client.connectToServer();
			connections.push(client);
			client.onMessage((message) => {
				if (offline) return;
				sent.push(JSON.parse(message.toString()));
				server.send(message);
			});
			server.onMessage((message) => {
				if (offline) return;
				received.push(JSON.parse(message.toString()));
				client.send(message);
			});
		},
	);

	try {
		await app.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
		await app.sendMessage(foreground);
		await expect
			.poll(() => chat.getLastAssistantText())
			.toBe(responseChunks(foreground).slice(0, 2).join("").trimEnd());
		await expect(chat.stopBtn).toBeVisible();
		expect(
			await Effect.runPromise(
				browser.rpc.input.submit({
					sessionId,
					originId: browser.originId,
					inputId,
					text: queued,
					delivery: "queue",
				}),
			),
		).toMatchObject({ ok: true });
		await expect(page.getByTestId("pending-input-text")).toHaveText(queued);
		await expect(chat.stopBtn).toBeVisible();
		report["pendingBeforeDisconnect"] = await page
			.getByTestId("pending-input-text")
			.allTextContents();
		const sentFrom = sent.length;
		const receivedFrom = received.length;
		if (connections.length === 0)
			throw new Error("Missing browser RPC connection");
		offline = true;
		await Promise.all(
			connections
				.splice(0)
				.map((client) =>
					client.close({ code: 1012, reason: "Test browser outage" }),
				),
		);

		// The existing SDK gate ends the foreground turn and drains its queue.
		writeFileSync(join(harness.root, "task-stop-release-result"), "release");
		await expect
			.poll(
				async () => {
					const history = await browser.history(sessionId);
					return history.some(
						(message) => message.text === responseChunks(queued).join(""),
					);
				},
				{ timeout: 30_000 },
			)
			.toBe(true);
		report["serverTranscriptBeforeReconnect"] = (
			await browser.history(sessionId)
		).map(({ id, role, text }) => ({ id, role, text }));
		// The tab still has the queued row; no delivery crossed the outage.
		await expect(page.getByTestId("pending-input-text")).toHaveText(queued);
		await expect(app.messages).not.toContainText(
			responseChunks(queued).join(""),
		);
		expect(received).toHaveLength(receivedFrom);
		report["consumedWhileDisconnected"] = true;
		offline = false;

		const requests = () =>
			sent
				.slice(sentFrom)
				.flatMap((value) =>
					find(
						value,
						(found) =>
							"tag" in found &&
							found.tag === "SubscribeSessionDetail" &&
							"payload" in found &&
							typeof found.payload === "object" &&
							found.payload !== null &&
							"sessionId" in found.payload &&
							found.payload.sessionId === sessionId,
					),
				);
		const envelopes = () => {
			const ids = new Set(
				requests().map((request) =>
					"id" in request ? String(request.id) : "",
				),
			);
			return received
				.slice(receivedFrom)
				.flatMap((value) =>
					find(
						value,
						(found) =>
							"_tag" in found &&
							found._tag === "Chunk" &&
							"requestId" in found &&
							ids.has(String(found.requestId)),
					),
				)
				.flatMap((chunk): object[] =>
					"values" in chunk && Array.isArray(chunk.values) ? chunk.values : [],
				);
		};
		await expect
			.poll(
				() =>
					envelopes().some(
						(envelope) =>
							"_tag" in envelope &&
							envelope._tag === "synchronized" &&
							"checksum" in envelope,
					),
				{ timeout: 30_000 },
			)
			.toBe(true);
		report["resumeRequests"] = requests();
		report["resumeEnvelopes"] = envelopes();
		await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
		await expect(chat.stopBtn).toBeHidden();
		await expect(
			app.messages.locator(".msg-user").filter({ hasText: queued }),
		).toHaveCount(1);
		await expect(
			app.messages
				.locator(".msg-assistant")
				.filter({ hasText: responseChunks(queued).join("") }),
		).toHaveCount(1);
		const transcript = (
			await app.messages
				.locator(".msg-user .whitespace-pre-wrap, .msg-assistant .md-content")
				.allTextContents()
		).map((text) => text.trim());
		const resumed = {
			detailRequests: requests().length,
			resumeBaseSent:
				find(requests()[0], (found) => "resumeBase" in found).length > 0,
			snapshots: envelopes().filter(
				(envelope) => "_tag" in envelope && envelope._tag === "snapshot",
			).length,
			mismatches,
			pendingAfterResume: await page
				.getByTestId("pending-input-text")
				.allTextContents(),
			transcript,
		};
		report["resumed"] = resumed;
		expect(transcript).toEqual(expectedTranscript);
		expect(resumed).toMatchObject({
			detailRequests: 1,
			resumeBaseSent: true,
			snapshots: 0,
			mismatches: 0,
			pendingAfterResume: [],
		});
		expect(pageErrors).toEqual([]);
		report["assertionsPassed"] = true;
	} finally {
		report["pageErrors"] = pageErrors;
		report["logTail"] = harness.logTail.slice(-3000);
		const output = testInfo.outputPath("pending-input-resume.json");
		writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
		await testInfo.attach("pending-input-resume", {
			path: output,
			contentType: "application/json",
		});
	}
});
