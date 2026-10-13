/*
 * Session-routing failure modes, through the browser RPC and relay boundary:
 * - An unknown provider selection must name its ref and create no OpenCode session.
 * - An unknown stored binding must reject sends with its typed ref intact,
 *   without calling either provider.
 * - Explicit account picks must beat driver/model defaults.
 * - Legacy driver and model-only picks must resolve the driver's current default.
 * - A fork must use the resolved account for receipts without rewriting its parent.
 * - A deleted non-default binding must launch in the default account's folder.
 * - With no native transcript in that folder, the handoff must preserve history.
 * All configuration and launch logins in this flow belong to a temporary fixture.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef } from "../../../src/lib/contracts/account.js";
import { AccountUnroutable } from "../../../src/lib/contracts/limit-recovery.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	type DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	addInstance,
	makeInstanceManagerStateLive,
	removeInstance,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	claudeSdk,
	responseChunks,
} from "../../helpers/fake-claude-process-sdk.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: account session routing", () => {
	const evidence: Array<{
		name: string;
		result: string | undefined;
		launchFolders: string[];
		forkFolders: string[];
		unknownBoundSend?: {
			code: string | undefined;
			error: string | undefined;
			ref: AccountRef;
			boundAccountId: string | undefined;
			sdkCalls: number;
			opencodePrompts: number;
		};
		deletedAccount?: {
			withHistory: boolean;
			prompts: string[];
			resumeIds: Array<string | undefined>;
		};
	}> = [];
	let root: string;
	let harness: RelayHarness | undefined;
	let disposeRegistry: (() => Promise<void>) | undefined;
	let launchFolders: string[];
	let forkFolders: string[];
	let unknownBoundSend: (typeof evidence)[number]["unknownBoundSend"];
	let deletedAccount: (typeof evidence)[number]["deletedAccount"];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "conduit-account-sessions-"));
		launchFolders = [];
		forkFolders = [];
		unknownBoundSend = undefined;
		deletedAccount = undefined;
		const home = join(root, "home");
		const login = join(root, "login");
		mkdirSync(home);
		mkdirSync(login);
		vi.stubEnv("HOME", home);
		vi.stubEnv("CLAUDE_CONFIG_DIR", login);
		vi.stubEnv("CONDUIT_CONFIG_DIR", root);
	});

	afterEach(async ({ task }) => {
		await harness?.stop();
		harness = undefined;
		await disposeRegistry?.();
		disposeRegistry = undefined;
		vi.unstubAllEnvs();
		evidence.push({
			name: task.name,
			result: task.result?.state,
			launchFolders: launchFolders.map((folder) =>
				folder.replace(root, "<fixture>"),
			),
			forkFolders: forkFolders.map((folder) =>
				folder.replace(root, "<fixture>"),
			),
			...(unknownBoundSend ? { unknownBoundSend } : {}),
			...(deletedAccount ? { deletedAccount } : {}),
		});
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/g4zp-15-session-routing.json",
			`${JSON.stringify({ cases: evidence }, null, 2)}\n`,
		);
		rmSync(root, { recursive: true, force: true });
	});

	it.each([
		false,
		true,
	])("routes a deleted non-default account to the default folder, preserving history=%s", async (withHistory) => {
		const login = join(root, "login");
		const removedLogin = join(root, "removed-login");
		mkdirSync(removedLogin);
		writeFileSync(join(removedLogin, "conduit-test-record-forks"), "");
		const registry = makeInstanceManagerStateLive(
			{},
			[
				{
					id: "claude",
					name: "Default Claude",
					driver: "claude",
					configDir: login,
					port: 0,
					managed: false,
				},
				{
					id: "removed",
					name: "Removed",
					driver: "claude",
					configDir: removedLogin,
					port: 0,
					managed: false,
				},
			],
			{ launchLogin: configuredClaudeConfigDir(login) },
		);
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				registry,
				DaemonEventBusLive,
				DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 0 })),
				Layer.succeed(ConfigPersistenceTag, {
					requestSave: Effect.void,
					flush: Effect.void,
				}),
			),
		);
		disposeRegistry = () => runtime.dispose();
		const daemonConfigContext = await runtime.runPromise(
			Effect.context<
				AccountDirectory | DaemonConfigRefTag | ConfigPersistenceTag
			>(),
		);
		const prompts: string[] = [];
		const resumeIds: Array<string | undefined> = [];
		harness = await createRelayHarness("chat-simple", {
			configDir: root,
			daemonConfigContext,
			defaultModel: null,
			claudeSdk: {
				...claudeSdk,
				query: (params) => {
					launchFolders.push(
						params.options?.env?.["CLAUDE_CONFIG_DIR"] ?? "unset",
					);
					resumeIds.push(params.options?.resume);
					const prompt = (async function* () {
						for await (const message of params.prompt) {
							const content = message.message.content;
							prompts.push(
								typeof content === "string"
									? content
									: content
											.flatMap((block) =>
												block.type === "text" ? [block.text] : [],
											)
											.join(""),
							);
							yield message;
						}
					})();
					return claudeSdk.query({ ...params, prompt });
				},
			},
		});
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Deleted account history", {
			instanceId: "removed",
		});
		const sessionId = created["id"];
		if (typeof sessionId !== "string")
			throw new Error("CreateSession returned no session id");
		const historyText = "history-before-account-deletion";
		if (withHistory) {
			const completed = client.waitForTurnEnd(sessionId, 10_000);
			await client.sendMessage(historyText, { sessionId });
			expect((await completed).attention).not.toBe("error");
			expect(launchFolders.at(-1)).toBe(removedLogin);
		}
		await runtime.runPromise(removeInstance("removed"));
		const defaultAccount = await runtime.runPromise(
			Effect.flatMap(AccountDirectory, (directory) =>
				directory.resolve({ _tag: "Id", id: "removed" }),
			),
		);
		expect(defaultAccount.id).toBe("claude");
		const nextText = "continue-after-account-deletion";
		const completed = client.waitForTurnEnd(sessionId, 10_000);
		await client.sendMessage(nextText, { sessionId });
		expect((await completed).attention).not.toBe("error");
		expect(launchFolders.at(-1)).toBe(login);
		expect(resumeIds.at(-1)).toBeUndefined();
		if (withHistory) {
			const handoff = prompts.at(-1);
			expect(handoff).toContain("[Conduit context handoff]");
			expect(handoff).toContain(historyText);
			expect(handoff).toContain(responseChunks(historyText).join(""));
			expect(
				handoff?.endsWith(`[End conduit context handoff]\n\n${nextText}`),
			).toBe(true);
		}
		const history = await client.loadMoreHistory(sessionId);
		expect(
			history.messages
				.filter((message) => message.role === "user")
				.map((message) =>
					message.parts
						?.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join(""),
				),
		).toEqual(withHistory ? [historyText, nextText] : [nextText]);
		expect(
			harness.mock.diagnostics.filter(
				(entry) =>
					entry.event === "request" && entry.detail?.includes("/prompt"),
			),
		).toHaveLength(0);
		deletedAccount = { withHistory, prompts, resumeIds };
	});

	it("rejects unknown creation and bound sends without provider fallback", async () => {
		const query = vi.fn(claudeSdk.query);
		harness = await createRelayHarness("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk: { ...claudeSdk, query },
		});
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const createsBefore = harness.mock.diagnostics.filter(
			(entry) => entry.event === "request" && entry.detail === "POST /session",
		).length;

		await expect(
			client.createSession("Unknown account", {
				providerId: "missing-account",
			}),
		).rejects.toThrow(/missing-account/);
		expect(
			harness.mock.diagnostics.filter(
				(entry) =>
					entry.event === "request" && entry.detail === "POST /session",
			).length,
		).toBe(createsBefore);

		const sessionId = "ses-missing-account";
		await harness.stack.effectRuntime.runtime.runPromise(
			applySessionCommand({
				type: "session.created",
				data: {
					sessionId,
					title: "Unavailable account",
					provider: "missing-account",
				},
			}),
		);
		const sendError = await client.rpcCall((rpc) =>
			rpc.input
				.submit({
					projectSlug: "integration-test",
					sessionId,
					inputId: "input-missing-account",
					text: "This account no longer exists",
					delivery: "queue",
				})
				.pipe(Effect.flip),
		);
		expect(sendError).toBeInstanceOf(AccountUnroutable);
		if (!(sendError instanceof AccountUnroutable))
			throw new Error("Expected a typed account routing failure");
		expect(sendError.ref).toEqual({ _tag: "Id", id: "missing-account" });
		expect(sendError.message).toContain("missing-account");
		const boundSession = await harness.stack.effectRuntime.runtime.runPromise(
			Effect.flatMap(ReadQueryEffectTag, (readQuery) =>
				readQuery.getSession(sessionId),
			),
		);
		expect(boundSession?.provider).toBe("missing-account");
		const opencodePrompts = harness.mock.diagnostics.filter(
			(entry) => entry.event === "request" && entry.detail?.includes("/prompt"),
		).length;
		expect(opencodePrompts).toBe(0);
		expect(query).not.toHaveBeenCalled();
		unknownBoundSend = {
			code: sendError._tag,
			error: sendError.message,
			ref: sendError.ref,
			boundAccountId: boundSession?.provider,
			sdkCalls: query.mock.calls.length,
			opencodePrompts,
		};
	});

	it("creates, sends and forks on a just-added account before its config is flushed", async () => {
		const login = join(root, "login");
		const addedLogin = join(root, "fresh-login");
		mkdirSync(addedLogin);
		writeFileSync(join(addedLogin, "conduit-test-record-forks"), "");
		const registry = makeInstanceManagerStateLive(
			{},
			[
				{
					id: "claude",
					name: "Default Claude",
					driver: "claude",
					configDir: login,
					port: 0,
					managed: false,
				},
			],
			{ launchLogin: configuredClaudeConfigDir(login) },
		);
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				registry,
				DaemonEventBusLive,
				DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 0 })),
				Layer.succeed(ConfigPersistenceTag, {
					requestSave: Effect.void,
					flush: Effect.fail(new Error("This fixture never flushes config")),
				}),
			),
		);
		disposeRegistry = () => runtime.dispose();
		const daemonConfigContext = await runtime.runPromise(
			Effect.context<
				AccountDirectory | DaemonConfigRefTag | ConfigPersistenceTag
			>(),
		);
		const resumedSessions: Array<string | undefined> = [];
		harness = await createRelayHarness("chat-simple", {
			configDir: root,
			daemonConfigContext,
			defaultModel: null,
			claudeSdk: {
				...claudeSdk,
				query: (params) => {
					launchFolders.push(
						params.options?.env?.["CLAUDE_CONFIG_DIR"] ?? "unset",
					);
					resumedSessions.push(params.options?.resume);
					return claudeSdk.query(params);
				},
				fork: {
					...claudeSdk.fork,
					forkSession: (sdkId, options) => {
						forkFolders.push(options.configDir.path);
						return claudeSdk.fork.forkSession(sdkId, options);
					},
				},
			},
		});
		await runtime.runPromise(
			addInstance({
				id: "fresh-claude",
				name: "Fresh Claude",
				driver: "claude",
				configDir: addedLogin,
				managed: false,
			}),
		);
		expect(existsSync(join(root, "daemon.json"))).toBe(false);
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const created = await client.createSession("Fresh account", {
			instanceId: "fresh-claude",
		});
		const sessionId = created["id"];
		if (typeof sessionId !== "string")
			throw new Error("CreateSession returned no session id");
		const completed = client.waitForTurnEnd(sessionId, 10_000);
		await client.sendMessage("Reply with pong", { sessionId });
		expect((await completed).attention).not.toBe("error");
		expect(launchFolders).toContain(addedLogin);
		const child = await client.forkSession({ sessionId });
		const childId = child["id"];
		if (typeof childId !== "string")
			throw new Error("ForkSession returned no session id");
		const rows = await client.waitForFamilyRows(
			childId,
			(row) => row.id === childId,
		);
		expect(rows.find((row) => row.id === childId)?.parentID).toBe(sessionId);
		expect(rows.find((row) => row.id === sessionId)?.title).toBe(
			"Fresh account",
		);
		const childCompleted = client.waitForTurnEnd(childId, 10_000);
		await client.sendMessage("Continue the fork", { sessionId: childId });
		expect((await childCompleted).attention).not.toBe("error");
		expect(forkFolders).toEqual([addedLogin]);
		expect(launchFolders.at(-1)).toBe(addedLogin);
		expect(resumedSessions.at(-1)).toBe(childId);
		expect(existsSync(join(root, "daemon.json"))).toBe(false);
	});
});
