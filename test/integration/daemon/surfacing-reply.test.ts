// Failure modes: token metadata leaks into the prompt, message quotes exceed
// 280 characters, excerpts are clipped with their chips, recap kinds diverge,
// free text or reference order changes, or providers receive different text.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	encodeReference,
	type ReplyReference,
	serializeReferences,
} from "../../../src/lib/composer-references.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

describe("Reply references through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	const evidence: Array<Record<string, unknown>> = [];

	afterEach(async () => {
		if (!harness) return;
		try {
			await harness.dispose();
			harness.assertNoRunners();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ahu8-12-reply-references.json",
				JSON.stringify(
					{
						ticket: "conduit-test-ahu8.12",
						scenarios: evidence,
						process: harness.proof(),
					},
					null,
					2,
				),
			);
			harness = undefined;
		}
	});

	it.each([
		"claude",
		"opencode",
	] as const)("sends the exact plain text to the %s agent", async (provider) => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			managedOpenCode: provider === "opencode",
		});
		const fixture = harness;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Reply serialization proof",
			provider === "opencode" ? "managed-test" : undefined,
			provider,
		);
		const message = "The routing change is safe. ".repeat(20);
		const excerpt =
			"Preserve this entire selected excerpt, including the words beyond the twenty-four-character chip and beyond the whole-message 280-character cap. ".repeat(
				3,
			);
		const references = [
			{
				kind: "message",
				ordinal: 24,
				category: "Ask",
				glyph: "?",
				time: "31:02",
				text: message,
			},
			{
				kind: "excerpt",
				ordinal: 18,
				category: "Decision",
				glyph: "◆",
				time: "22:40",
				text: excerpt,
			},
			{ kind: "recap-excerpt", text: "Keep the old paint order." },
		] as const satisfies readonly ReplyReference[];
		const draft = `Before ${encodeReference(references[0])} middle ${references.slice(1).map(encodeReference).join("")} after`;
		const expected = [
			`Re #24 (Ask, 31:02): "${message.slice(0, 280).trimEnd()}…"`,
			`Re #18 (Decision, 22:40): "${excerpt.trim()}"`,
			'Re recap: "Keep the old paint order."',
			"",
			"Before middle after",
		].join("\n");
		const serialized = serializeReferences(draft);
		expect(serialized).toBe(expected);
		await sendRpcRequest(join(fixture.configDir, "relay.sock"), {
			_tag: "input.submit",
			sessionId,
			inputId: `reply-${provider}`,
			text: serialized,
			delivery: "queue",
		});
		let received: string | undefined;
		await vi.waitFor(
			() => {
				if (provider === "claude") {
					const enqueue = fixture.marks.find((mark) => mark.kind === "enqueue");
					received = enqueue?.kind === "enqueue" ? enqueue.prompt : undefined;
				} else {
					const sent = fixture
						.opencodeRequestBodies()
						.find(({ path }) => path === `/session/${sessionId}/prompt_async`);
					const body = JSON.parse(sent?.body ?? "{}") as {
						parts?: Array<{ type: string; text?: string }>;
					};
					received = body.parts
						?.filter(({ type }) => type === "text")
						.map(({ text }) => text ?? "")
						.join("");
				}
				expect(received).toBe(expected);
			},
			{ timeout: 10_000 },
		);
		// Conduit stores a Claude prompt itself; an OpenCode user message comes
		// back from OpenCode's own events, which the managed mock never echoes.
		let persisted: string | undefined;
		if (provider === "claude") {
			const sent = (await browser.history(sessionId)).find(
				({ role }) => role === "user",
			);
			persisted =
				sent?.text ??
				sent?.parts
					?.filter(({ type }) => type === "text")
					.map(({ text }) => text ?? "")
					.join("");
			expect(persisted).toBe(expected);
		}
		evidence.push({ provider, expected, received, persisted });
	});
});
