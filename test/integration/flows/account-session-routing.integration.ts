/*
 * Session-routing failure modes, through the browser RPC and relay boundary:
 * - An unknown provider selection must name its ref and create no OpenCode session.
 * - An unknown stored binding must reject sends with its typed ref intact,
 *   without calling either provider.
 * - Explicit account picks must beat driver/model defaults.
 * - Legacy driver and model-only picks must resolve the driver's current default.
 * - A fork must use the resolved account for receipts without rewriting its parent.
 * - A deleted default or non-default binding must launch in the default folder.
 * - With no native transcript in that folder, the handoff must preserve history.
 * - With zero Claude accounts, creates/sends must fail despite OpenCode existing.
 * - Local session renames must persist after the last Claude account is removed.
 * - Adding after the last removal must restore the old session on a fresh ID.
 * - SetDefault through daemon RPC must change the next draft's launch folder,
 *   including model-only picks, while an explicit account pick still wins.
 * All configuration and launch logins in this flow belong to a temporary fixture.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef } from "../../../src/lib/contracts/account.js";
import { AccountUnroutable } from "../../../src/lib/contracts/limit-recovery.js";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";

import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	addInstance,
	removeInstance,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import {
	claudeSdk,
	responseChunks,
} from "../../helpers/fake-claude-process-sdk.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";

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
			removedId: string;
			restoredId?: string;
			prompts: string[];
			resumeIds: Array<string | undefined>;
			renamedTitle?: string;
		};
	}> = [];
	let root: string;
	let harness: DaemonProject | undefined;
	let launchFolders: string[];
	let forkFolders: string[];
	let unknownBoundSend: (typeof evidence)[number]["unknownBoundSend"];
	let deletedAccount: (typeof evidence)[number]["deletedAccount"];

	beforeEach(() => {
		__setProbeOverrideForTesting(async () => ({
			models: [],
			commands: [],
			agents: [],
		}));
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
		try {
			await harness?.stop();
			harness = undefined;
		} finally {
			__setProbeOverrideForTesting(undefined);
		}
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
		{ removeDefault: false, withHistory: false },
		{ removeDefault: false, withHistory: true },
		{ removeDefault: true, withHistory: false },
		{ removeDefault: true, withHistory: true },
	])("routes a deleted account to the default folder and preserves history: %j", async ({
		removeDefault,
		withHistory,
	}) => {
		const login = join(root, "login");
		const removedLogin = join(root, "removed-login");
		const removedId = removeDefault ? "claude" : "removed";
		const promotedId = removeDefault ? "removed" : "claude";
		const sourceLogin = removeDefault ? login : removedLogin;
		const targetLogin = removeDefault ? removedLogin : login;
		mkdirSync(removedLogin);
		writeFileSync(join(removedLogin, "conduit-test-record-forks"), "");
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				instances: [
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
			},
			root,
		);
		const prompts: string[] = [];
		const resumeIds: Array<string | undefined> = [];
		harness = await createDaemonProject("chat-simple", {
			configDir: root,
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
		await client.waitFor("shell", {
			predicate: (message) => message["_tag"] === "synchronized",
		});
		const created = await client.createSession("Deleted account history", {
			instanceId: removedId,
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sessionId = created["id"];
		if (typeof sessionId !== "string")
			throw new Error("CreateSession returned no session id");
		const historyText = "history-before-account-deletion";
		if (withHistory) {
			const completed = client.waitForTurnEnd(sessionId, 10_000);
			await client.sendMessage(historyText, { sessionId });
			expect((await completed).attention).not.toBe("error");
			expect(launchFolders.at(-1)).toBe(sourceLogin);
		}
		await harness.run(removeInstance(removedId));
		const defaultAccount = await harness.run(
			Effect.flatMap(AccountDirectory, (directory) =>
				directory.resolve({ _tag: "Id", id: removedId }),
			),
		);
		expect(defaultAccount.id).toBe(promotedId);
		const nextText = "continue-after-account-deletion";
		await client.sendMessage(nextText, { sessionId });
		// sendMessage captures this turn's completion fence.
		const completed = client.waitForTurnEnd(sessionId, 10_000);
		expect((await completed).attention).not.toBe("error");
		expect(launchFolders.at(-1)).toBe(targetLogin);
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
		deletedAccount = { withHistory, removedId, prompts, resumeIds };
		if (removeDefault && withHistory) {
			await harness.run(removeInstance(promotedId));
			const renamedTitle = "Retained history without a Claude account";
			await client.renameSession(sessionId, renamedTitle);
			const renamed = await harness.run(
				Effect.flatMap(ReadQueryEffectTag, (readQuery) =>
					readQuery.getSession(sessionId),
				),
			);
			expect(renamed?.title).toBe(renamedTitle);
			deletedAccount.renamedTitle = renamedTitle;
			const launchesBefore = launchFolders.length;
			await expect(
				client.createSession("No Claude account", { providerId: "claude" }),
			).rejects.toThrow(/claude/);
			const sendError = await client.rpcCall((rpc) =>
				rpc["input.submit"]({
					sessionId,
					inputId: "input-after-last-account-removed",
					text: "Cannot send without a Claude account",
					delivery: "queue",
				}).pipe(Effect.flip),
			);
			expect(sendError).toMatchObject({
				_tag: "AccountUnroutable",
				ref: { _tag: "Id", id: removedId },
			});
			expect(launchFolders).toHaveLength(launchesBefore);
			expect(
				harness.mock.diagnostics.filter(
					(entry) =>
						entry.event === "request" &&
						(entry.detail === "POST /session" ||
							entry.detail?.includes("/prompt")),
				),
			).toEqual([]);
			const restoredLogin = join(root, "restored-login");
			mkdirSync(restoredLogin);
			const restored = await harness.run(
				addInstance({
					name: "Removed",
					driver: "claude",
					configDir: restoredLogin,
				}),
			);
			expect(restored.id).toBe("removed-2");
			expect(restored.isDefault).toBe(true);
			const restoredText = "continue-after-account-restored";
			await client.sendMessage(restoredText, { sessionId });
			const restoredTurn = client.waitForTurnEnd(sessionId, 10_000);
			expect((await restoredTurn).attention).not.toBe("error");
			expect(launchFolders.at(-1)).toBe(restoredLogin);
			expect(prompts.at(-1)).toContain(historyText);
			expect(prompts.at(-1)).toContain(nextText);
			deletedAccount.restoredId = restored.id;
		}
	});

	it("rejects unknown creation and bound sends without provider fallback", async () => {
		const query = vi.fn(claudeSdk.query);
		harness = await createDaemonProject("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk: { ...claudeSdk, query },
		});
		const client = await harness.connectWsClient();
		await client.waitFor("shell", {
			predicate: (message) => message["_tag"] === "synchronized",
		});
		const createsBefore = harness.mock.diagnostics.filter(
			(entry) => entry.event === "request" && entry.detail === "POST /session",
		).length;

		await expect(
			client.rpcCall((rpc) =>
				rpc.CreateSession({
					permissionMode: "ask",
					projectSlug: "integration-test",
					originId: "unknown-account-fixture",
					title: "Unknown account",
					instanceId: AccountIdSchema.make("missing-account"),
					providerId: "claude",
					model: {
						providerId: "claude",
						modelId: "sonnet",
						variant: "",
						contextWindow: "200k",
					},
				}),
			),
		).rejects.toThrow(/missing-account/);
		expect(
			harness.mock.diagnostics.filter(
				(entry) =>
					entry.event === "request" && entry.detail === "POST /session",
			).length,
		).toBe(createsBefore);

		const sessionId = "ses-missing-account";
		await harness.run(
			applySessionCommand(
				{
					type: "session.created",
					data: {
						sessionId,
						title: "Unavailable account",
						provider: "missing-account",
					},
				},
				{
					pick: {
						harness: "claude",
						model: { providerId: "claude", modelId: "sonnet" },
						effort: "",
						contextWindow: "200k",
					},
				},
			),
		);
		const sendError = await client.rpcCall((rpc) =>
			rpc["input.submit"]({
				sessionId,
				inputId: "input-missing-account",
				text: "This account no longer exists",
				delivery: "queue",
			}).pipe(Effect.flip),
		);
		expect(sendError).toBeInstanceOf(AccountUnroutable);
		if (!(sendError instanceof AccountUnroutable))
			throw new Error("Expected a typed account routing failure");
		expect(sendError.ref).toEqual({ _tag: "Id", id: "missing-account" });
		expect(sendError.message).toContain("missing-account");
		const boundSession = await harness.run(
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

	it("creates, sends and forks on a just-added account", async () => {
		const login = join(root, "login");
		const addedLogin = join(root, "fresh-login");
		mkdirSync(addedLogin);
		writeFileSync(join(addedLogin, "conduit-test-record-forks"), "");
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				instances: [
					{
						id: "claude",
						name: "Default Claude",
						driver: "claude",
						configDir: login,
						port: 0,
						managed: false,
					},
				],
			},
			root,
		);
		const resumedSessions: Array<string | undefined> = [];
		const forkSessionIds: Array<string | undefined> = [];
		harness = await createDaemonProject("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk: {
				...claudeSdk,
				query: (params) => {
					launchFolders.push(
						params.options?.env?.["CLAUDE_CONFIG_DIR"] ?? "unset",
					);
					resumedSessions.push(params.options?.resume);
					if (params.options?.forkSession)
						forkSessionIds.push(params.options.sessionId);
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
		await harness.run(
			addInstance({
				id: "fresh-claude",
				name: "Fresh Claude",
				driver: "claude",
				configDir: addedLogin,
				managed: false,
			}),
		);
		const client = await harness.connectWsClient();
		await client.waitFor("shell", {
			predicate: (message) => message["_tag"] === "synchronized",
		});
		const created = await client.createSession("Fresh account", {
			instanceId: "fresh-claude",
			model: {
				providerId: "claude",
				modelId: "sonnet",
				variant: "",
				contextWindow: "200k",
			},
		});
		const sessionId = created["id"];
		if (typeof sessionId !== "string")
			throw new Error("CreateSession returned no session id");
		// sendMessage captures each turn's completion fence; a Fork's copied
		// history can already carry a turn end before its own turn starts.
		await client.sendMessage("Reply with pong", { sessionId });
		const completed = client.waitForTurnEnd(sessionId, 10_000);
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
		expect(rows.find((row) => row.id === childId)?.forkedFrom).toBe(sessionId);
		// A Fork is its own Family Root, so its Source is read from its own family.
		const sourceRows = await client.waitForFamilyRows(
			sessionId,
			(row) => row.id === sessionId,
		);
		expect(sourceRows.find((row) => row.id === sessionId)?.title).toBe(
			"Fresh account",
		);
		await client.sendMessage("Continue the fork", { sessionId: childId });
		const childCompleted = client.waitForTurnEnd(childId, 10_000);
		expect((await childCompleted).attention).not.toBe("error");
		expect(forkFolders).toEqual([]);
		expect(launchFolders.at(-1)).toBe(addedLogin);
		expect(resumedSessions.at(-1)).toEqual(expect.any(String));
		expect(resumedSessions.at(-1)).not.toBe(childId);
		expect(forkSessionIds).toEqual([childId]);
	});

	it.each([
		"legacy-binding",
		"driver-only",
		"legacy-alias",
	] as const)("runs %s selections in Personal's folder", async (selection) => {
		const login = join(root, "personal-login");
		const original = join(root, "original-login");
		mkdirSync(login);
		mkdirSync(original);
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				accountDefaults: { claude: AccountIdSchema.make("personal") },
				instances: [
					{
						id: "personal",
						name: "Personal",
						driver: "claude",
						configDir: login,
						port: 0,
						managed: false,
					},
					...(selection === "legacy-binding"
						? []
						: [
								{
									id: "claude",
									name: "Original",
									driver: "claude" as const,
									configDir: original,
									port: 0,
									managed: false,
								},
							]),
				],
			},
			root,
		);
		harness = await createDaemonProject("chat-simple", {
			configDir: root,
			defaultModel: null,
			claudeSdk: {
				...claudeSdk,
				query: (params) => {
					launchFolders.push(
						params.options?.env?.["CLAUDE_CONFIG_DIR"] ?? "unset",
					);
					return claudeSdk.query(params);
				},
			},
		});
		const client = await harness.connectWsClient();
		await client.waitFor("shell", {
			predicate: (message) => message["_tag"] === "synchronized",
		});
		let sessionId: string;
		if (selection === "legacy-binding") {
			sessionId = "ses-legacy-claude-binding";
			await harness.run(
				applySessionCommand(
					{
						type: "session.created",
						data: { sessionId, title: "Legacy binding", provider: "claude" },
					},
					{
						pick: {
							harness: "claude",
							model: { providerId: "claude", modelId: "sonnet" },
							effort: "",
							contextWindow: "200k",
						},
					},
				),
			);
			await client.viewSession(sessionId);
		} else {
			const created = await client.rpcCall((rpc) =>
				rpc.CreateSession({
					permissionMode: "ask",
					projectSlug: "integration-test",
					originId: "legacy-account-fixture",
					title: "Personal default",
					providerId: selection === "legacy-alias" ? "claude-sdk" : "claude",
					model: {
						providerId: "claude",
						modelId: "sonnet",
						variant: "",
						contextWindow: "200k",
					},
				}),
			);
			const id = created.sessionId;
			if (typeof id !== "string")
				throw new Error("CreateSession returned no session id");
			sessionId = id;
			await client.viewSession(sessionId);
		}
		const completed = client.waitForTurnEnd(sessionId, 10_000);
		await client.sendMessage("Reply with pong", { sessionId });
		expect((await completed).attention).not.toBe("error");
		expect(launchFolders.at(-1)).toBe(login);
		expect(launchFolders).not.toContain(original);
		const stored = await harness.run(
			Effect.flatMap(ReadQueryEffectTag, (read) => read.getSession(sessionId)),
		);
		expect(stored?.provider).toBe(
			selection === "legacy-binding" ? "claude" : "personal",
		);
	});

	it.each([
		"default",
		"model-only",
		"explicit",
	] as const)("SetDefault routes a %s draft's first turn to its selected folder", async (selection) => {
		const original = join(root, "original-login");
		const personal = join(root, "personal-login");
		mkdirSync(original);
		mkdirSync(personal);
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				instances: [
					{
						id: "claude",
						name: "Claude",
						driver: "claude",
						configDir: original,
						port: 0,
						managed: false,
					},
					{
						id: "personal",
						name: "Personal",
						driver: "claude",
						configDir: personal,
						port: 0,
						managed: false,
					},
				],
			},
			root,
		);
		__setProbeOverrideForTesting(async () => ({
			models: [{ id: "shared", name: "Shared Sonnet", providerId: "claude" }],
			agents: [],
			commands: [],
		}));
		try {
			harness = await createDaemonProject("chat-simple", {
				configDir: root,
				defaultModel: null,
				claudeSdk: {
					...claudeSdk,
					query: (params) => {
						launchFolders.push(
							params.options?.env?.["CLAUDE_CONFIG_DIR"] ?? "unset",
						);
						return claudeSdk.query(params);
					},
				},
			});
			const client = await harness.connectWsClient();
			await client.waitFor("shell", {
				predicate: (message) => message["_tag"] === "synchronized",
			});
			await harness.run(
				Effect.flatMap(DaemonWsRpcHandlersTag, (handlers) =>
					handlers.SetDefault({ _tag: "SetDefault", instanceId: "personal" }),
				),
			);
			const result = await client.rpcCall((rpc) =>
				rpc.CreateSession({
					permissionMode: "ask",
					projectSlug: "integration-test",
					originId: "g4zp8-first-turn",
					...(selection === "explicit"
						? { instanceId: AccountIdSchema.make("claude") }
						: selection === "default"
							? { providerId: "claude" }
							: {}),
					model: {
						providerId: "claude",
						modelId: "shared",
						variant: "",
						contextWindow: "",
					},
				}),
			);
			await client.viewSession(result.sessionId);
			const completed = client.waitForTurnEnd(result.sessionId, 10_000);
			await client.sendMessage("Reply with pong", {
				sessionId: result.sessionId,
			});
			expect((await completed).attention).not.toBe("error");
			expect(launchFolders.at(-1)).toBe(
				selection === "explicit" ? original : personal,
			);
		} finally {
			__setProbeOverrideForTesting(undefined);
		}
	});
});
