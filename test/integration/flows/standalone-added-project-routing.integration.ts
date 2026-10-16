/*
 * A standalone relay stack gives each added project its own store, so the
 * stack's /rpc must resolve sessions across every mounted relay. Failure modes:
 * - A session created in an added project is answered as unknown-session,
 *   because only the initial relay's store is consulted.
 * - The test passes vacuously because the initial relay also owns the session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SessionDirectory } from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

const sessionId = "ses_added_project";

describe("Integration: standalone added-project routing", () => {
	let harness: RelayHarness | undefined;
	const folder = mkdtempSync(join(tmpdir(), "conduit-added-project-"));

	afterEach(async () => {
		await harness?.stop();
		rmSync(folder, { recursive: true, force: true });
	});

	it("routes RPCs for a session that lives only in an added project", async () => {
		const recording = loadOpenCodeRecording("chat-simple");
		recording.interactions = recording.interactions.map((interaction) =>
			interaction.kind === "rest" &&
			interaction.method === "POST" &&
			interaction.path === "/session"
				? {
						...interaction,
						responseBody: {
							...(interaction.responseBody as object),
							id: sessionId,
							directory: folder,
						},
					}
				: interaction,
		);
		harness = await createRelayHarness(recording);
		const client = await harness.connectWsClient();
		try {
			const saved = await client.rpcCall((c) =>
				c.SaveProject({ projectSlug: "integration-test", folders: [folder] }),
			);
			const created = await client.rpcCall((c) =>
				c.CreateSession({
					projectSlug: saved.savedSlug,
					originId: "added-project",
					providerId: "opencode",
					permissionMode: "ask",
					title: "Added project",
					model: {
						providerId: "anthropic",
						modelId: "claude-opus-4-5-20251101",
						variant: "high",
					},
				}),
			);
			expect(created).toEqual({ projectSlug: saved.savedSlug, sessionId });

			const initialOwner = await harness.stack.effectRuntime.runtime.runPromise(
				Effect.flatMap(SessionDirectory, (d) => d.projectOf(sessionId)),
			);
			expect(Option.isNone(initialOwner)).toBe(true);

			const read = await client.rpcCall((c) =>
				Effect.either(c.MarkSessionRead({ sessionId })),
			);
			expect(Either.isRight(read)).toBe(true);
		} finally {
			await client.close();
		}
	}, 30_000);
});
