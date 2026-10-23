// Failure modes: file-only rows lose their parts; image/document bytes change;
// redispatch duplicates parts; reopening or fork copy drops attachments;
// history omits filenames; ThreadRead hides user documents or emits raw binary.
// OpenCode synchronization moves attachment fields from metadata to rest_payload.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { makeAttachmentStore } from "../../../src/lib/persistence/attachment-store.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { readForkSource } from "../../../src/lib/persistence/fork-history.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import { makeClaudeThreadRead } from "../../../src/lib/provider/claude/claude-thread-read.js";

it("retains canonical user attachments through reopen, fork, browser history and ThreadRead", async () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-user-attachments-"));
	const filename = join(dir, "events.db");
	const text = "Document bytes 🧪\nline two";
	const attachments = [
		{ name: "notes.txt", mime: "text/plain", data: Buffer.from(text) },
		{
			name: "brief.pdf",
			mime: "application/pdf",
			data: Buffer.from("%PDF-1.7\nfixture\n%%EOF"),
		},
		{
			name: "diagram.png",
			mime: "image/png",
			data: Buffer.from("image bytes"),
		},
	];
	const images = attachments.map(
		({ name, mime, data }) =>
			`data:${mime};name=${encodeURIComponent(name)};base64,${data.toString("base64")}`,
	);
	const layer = () =>
		Layer.fresh(makePersistenceEffectLayer(filename, "test-project"));
	try {
		const refs = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const persist = yield* ClaudeEventPersistEffectTag;
					const attachmentStore = yield* makeAttachmentStore;
					const refs = yield* Effect.forEach(images, attachmentStore.put);
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "parent", {
							sessionId: "parent",
							title: "Attachments",
							provider: "claude",
						}),
					]);
					for (const [messageId, content] of [
						["file-only", ""],
						["mixed", "See attached"],
					] as const) {
						// Redispatch uses the same input ID and must remain idempotent.
						for (let attempt = 0; attempt < 2; attempt++)
							yield* persist.persistUserMessage("parent", content, {
								messageId,
								inputId: messageId,
								images: refs,
							});
					}
					return refs;
				}).pipe(Effect.provide(layer())),
			),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const read = yield* ReadQueryEffectTag;
					const source = yield* readForkSource("parent", { sideThread: false });
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "fork", {
							sessionId: "fork",
							title: "Fork",
							provider: "claude",
							forkedFrom: "parent",
							inheritsHistory: true,
							forkPointMessageId: source.boundary.messageId,
							forkPointTimestamp: source.boundary.createdAt,
						}),
					]);
					const threadRead = yield* makeClaudeThreadRead;
					for (const sessionId of ["parent", "fork"]) {
						const page = yield* read.readSessionTranscriptPage(sessionId, {
							limit: 20,
							forward: {},
						});
						const history = messageRowsToHistory(page.messages, {
							pageSize: 20,
						});
						expect(history.messages).toHaveLength(2);
						for (const [index, message] of history.messages.entries()) {
							expect(message.role).toBe("user");
							expect(message["text"] ?? "").toBe(
								index === 0 ? "" : "See attached",
							);
							const files = (message.parts ?? []).filter(
								(part) => part.type === "file",
							);
							expect(
								files.map(({ filename, mime, source }) => ({
									filename,
									mime,
									source,
								})),
							).toEqual(
								attachments.map(({ name, mime }, attachmentIndex) => ({
									filename: name,
									mime,
									source: refs[attachmentIndex],
								})),
							);
						}
						const result = yield* threadRead(sessionId, { limit: 20 });
						expect(
							"items" in result &&
								result.items.map(({ text: content }) => content),
						).toEqual(
							["", "See attached"].map((content) =>
								[
									...(content ? [content] : []),
									...attachments.map(
										({ name, mime, data }) =>
											`Attachment: ${name} (${mime}, ${data.length} bytes)${mime === "text/plain" ? `\n${text}` : ""}`,
									),
								].join("\n"),
							),
						);
					}
				}).pipe(Effect.provide(layer())),
			),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("retains attachment context when canonical parts become OpenCode REST snapshots", async () => {
	const text = "Document bytes 🧪\nline two";
	const files = [
		{ filename: "notes.txt", mime: "text/plain", bytes: Buffer.from(text) },
		{
			filename: "brief.pdf",
			mime: "application/pdf",
			bytes: Buffer.from("%PDF-1.7\nfixture"),
		},
	];
	const providerParts = files.map(({ filename, mime, bytes }, index) => ({
		id: `message-attachment-${index}`,
		type: "file",
		filename,
		mime,
		url: `data:${mime};name=${filename};base64,${bytes.toString("base64")}`,
	}));
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const attachmentStore = yield* makeAttachmentStore;
				const parts = yield* Effect.forEach(providerParts, ({ url, ...part }) =>
					Effect.map(attachmentStore.put(url), (source) => ({
						...part,
						source,
					})),
				);
				const read = yield* ReadQueryEffectTag;
				const threadRead = yield* makeClaudeThreadRead;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "opencode-session", {
						sessionId: "opencode-session",
						title: "Attachments",
						provider: "opencode",
					}),
				]);
				yield* persist.persistUserMessage("opencode-session", "", {
					messageId: "message",
					provider: "opencode",
					images: parts.map(({ source }) => source),
				});
				const before = yield* threadRead("opencode-session", { limit: 20 });
				expect(
					"items" in before && before.items.map(({ text: content }) => content),
				).toEqual([
					files
						.map(
							({ filename, mime, bytes }) =>
								`Attachment: ${filename} (${mime}, ${bytes.length} bytes)${mime === "text/plain" ? `\n${text}` : ""}`,
						)
						.join("\n"),
				]);
				yield* persist.persistEvent(
					canonicalEvent(
						"message.snapshot",
						"opencode-session",
						{
							messageId: "message",
							digest: "rest-snapshot",
							message: {
								id: "message",
								sessionID: "opencode-session",
								role: "user",
								parts,
							},
						},
						{ provider: "opencode", metadata: { rawSource: "opencode.rest" } },
					),
				);
				const rows =
					yield* read.getSessionMessagesWithParts("opencode-session");
				expect(rows[0]?.parts.map(({ metadata }) => metadata)).toEqual([
					null,
					null,
				]);
				expect(
					rows[0]?.parts.map(({ rest_payload }) =>
						JSON.parse(rest_payload ?? "null"),
					),
				).toEqual(parts);
				const after = yield* threadRead("opencode-session", { limit: 20 });
				expect(
					"items" in after && after.items.map(({ text: content }) => content),
				).toEqual(
					"items" in before && before.items.map(({ text: content }) => content),
				);
				const history = messageRowsToHistory(rows, { pageSize: 20 });
				expect(history.messages[0]?.parts).toEqual(parts);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		),
	);
});
