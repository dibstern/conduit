// Failure cases: account or project defaults leak into discovery/sends, replies
// use a stale call cwd, or missing routes/empty stored directories fall back.
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { Effect, Fiber, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AccountIdSchema,
	type OpenCodeAccount,
} from "../../../src/lib/contracts/account.js";
import { makeOpenCodeInstancesLive } from "../../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSdkClient } from "../../../src/lib/instance/sdk-factory.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import type {
	ProviderCall,
	TurnResult,
} from "../../../src/lib/provider/types.js";

describe("OpenCode adapter call routing through OpenCode Instances", () => {
	const servers: Server[] = [];
	let runtime: ManagedRuntime.ManagedRuntime<OpenCodeInstancesTag, never>;
	let defaultClient: OpenCodeAPI;
	let provider: OpenCodeProviderInstance;
	let storedDirectory: string | undefined;
	let sessionRead: (() => Promise<void>) | undefined;
	let requests: Array<{
		account: string;
		method: string;
		path: string;
		directory: string | null;
		headerDirectory: string | null;
		body: unknown;
	}> = [];

	afterEach(async ({ task }) => {
		try {
			await runtime?.dispose();
		} finally {
			await Promise.all(
				servers.splice(0).map(
					(server) =>
						new Promise<void>((resolve) => {
							server.closeAllConnections();
							server.close(() => resolve());
						}),
				),
			);
			writeFileSync(
				"/tmp/82tn-9-6-opencode-call-routing.json",
				JSON.stringify({ result: task.result?.state, requests }, null, 2),
			);
			requests = [];
		}
	});

	beforeEach(async () => {
		storedDirectory = undefined;
		sessionRead = undefined;
		const endpoints = new Map<string, { url: string }>();
		for (const account of ["a", "b", "default"]) {
			const server = createServer(async (request, response) => {
				const url = new URL(request.url ?? "/", "http://fixture");
				const directory =
					url.searchParams.get("directory") ??
					(typeof request.headers["x-opencode-directory"] === "string"
						? decodeURIComponent(request.headers["x-opencode-directory"])
						: null);
				let raw = "";
				for await (const chunk of request) raw += String(chunk);
				requests.push({
					account,
					method: request.method ?? "GET",
					path: url.pathname,
					directory,
					headerDirectory:
						typeof request.headers["x-opencode-directory"] === "string"
							? decodeURIComponent(request.headers["x-opencode-directory"])
							: null,
					body: raw ? (JSON.parse(raw) as unknown) : null,
				});
				if (url.pathname === "/global/event") {
					response.writeHead(200, { "Content-Type": "text/event-stream" });
					response.write('data: {"payload":{"type":"server.connected"}}\n\n');
					return;
				}
				const sessionId = /^\/session\/([ab]-[^/]+)$/.exec(url.pathname)?.[1];
				let body: unknown = true;
				if (sessionId) {
					await sessionRead?.();
					body = {
						id: sessionId,
						projectID: "fixture",
						directory: storedDirectory ?? `/stored/${sessionId}`,
						title: sessionId,
						version: "1",
						time: { created: 1, updated: 1 },
					};
				} else if (url.pathname === "/provider") {
					body = { all: [], default: {}, connected: [] };
				} else if (url.pathname === "/command" || url.pathname === "/skill") {
					body = [{ name: `${account}:${directory}`, template: "fixture" }];
				} else if (url.pathname === "/permission") {
					body = directory?.startsWith("/stored/")
						? [
								{
									id: "permission",
									sessionID: directory.slice(8),
									permission: "edit",
									always: ["*.ts"],
								},
							]
						: [];
				} else if (url.pathname === "/question") {
					body = [];
				} else if (url.pathname === "/session/status") {
					body = {};
				} else if (url.pathname === "/path") {
					body = {
						directory: "/server-default",
						worktree: "/",
						state: "/",
						config: "/",
						home: "/",
					};
				}
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify(body));
			});
			servers.push(server);
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("No fixture port");
			endpoints.set(account, { url: `http://127.0.0.1:${address.port}` });
		}
		runtime = ManagedRuntime.make(
			makeOpenCodeInstancesLive((id) => Effect.succeed(endpoints.get(id)), {
				log: createSilentLogger(),
			}),
		);
		const instances = await runtime.runPromise(OpenCodeInstancesTag);
		const baseUrl = endpoints.get("default")?.url;
		if (!baseUrl) throw new Error("No default fixture endpoint");
		const sdk = createSdkClient({ baseUrl, directory: "/constructor" });
		defaultClient = new OpenCodeAPI({
			sdk: sdk.client,
			baseUrl,
			authHeaders: {},
		});
		provider = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(defaultClient),

			clientForAccount: (account, directory) =>
				instances.use(account.id, directory),
		});
	});

	it("keeps two accounts across two projects separate and answers in the stored session directory", async () => {
		const calls: ProviderCall[] = ["a", "b"].flatMap((id) =>
			["one", "two"].map((projectId) => ({
				projectId,
				sessionId: `${id}-${projectId}`,
				account: {
					id: AccountIdSchema.make(id),
					name: id,
					driver: "opencode",
					usageEligible: false,
				} satisfies OpenCodeAccount,
				workspaceRoot: `/projects/${projectId}`,
				extraFolders: [],
				shellEnv: {},
			})),
		);
		await Promise.all(
			calls.map(async (call) => {
				const discovery = await Effect.runPromise(
					Effect.result(
						provider.discoverEffect(
							"/stale",
							calls[0]?.account,
							undefined,
							call,
						),
					),
				);
				if (discovery._tag === "Failure")
					throw new Error(JSON.stringify(discovery.failure));
				const capabilities = discovery.success;
				expect(capabilities.commands.map(({ name }) => name)).toEqual([
					`${call.account.id}:${call.workspaceRoot}`,
					`${call.account.id}:${call.workspaceRoot}`,
				]);
				const intake: TurnResult = {
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				};
				await Effect.runPromise(
					provider.sendTurnEffect({
						...call,
						inputId: call.sessionId,
						prompt: call.sessionId,
						history: [],
						providerState: {},
						eventSink: {
							push: () => Effect.void,
							requestPermission: () => Effect.die("Unexpected permission wait"),
							requestQuestion: () => Effect.die("Unexpected question wait"),
							resolvePermission: () => Effect.void,
							resolveQuestion: () => Effect.void,
						},
						abortSignal: new AbortController().signal,
						awaitIntake: Effect.succeed(intake),
					}),
				);
				for (const decision of ["once", "reject", "always"] as const)
					await Effect.runPromise(
						provider.resolvePermissionEffect(
							call.sessionId,
							"permission",
							decision,
							undefined,
							call,
						),
					);
				await Effect.runPromise(
					provider.resolveQuestionEffect(
						call.sessionId,
						"question",
						{ choice: "yes" },
						call,
					),
				);
			}),
		);
		for (const call of calls) {
			const own = requests.filter(({ account }) => account === call.account.id);
			const sessionPath = `/session/${call.sessionId}`;
			expect(
				own
					.filter(({ path }) => path === `${sessionPath}/prompt_async`)
					.map(({ directory }) => directory),
			).toEqual([call.workspaceRoot]);
			expect
				.soft(
					own
						.filter(
							({ path }) => path === `${sessionPath}/permissions/permission`,
						)
						.map(({ directory }) => directory),
				)
				.toEqual(Array<string>(3).fill(`/stored/${call.sessionId}`));
			expect
				.soft(
					own
						.filter(
							({ path }) => path === `${sessionPath}/permissions/permission`,
						)
						.every(({ headerDirectory }) => headerDirectory === null),
				)
				.toBe(true);
			expect
				.soft(
					own.some(
						({ method, path, body }) =>
							method === "PATCH" &&
							path === sessionPath &&
							JSON.stringify(body) ===
								JSON.stringify({
									permission: [
										{ permission: "edit", pattern: "*.ts", action: "allow" },
									],
								}),
					),
				)
				.toBe(true);
			expect
				.soft(
					own
						.filter(
							({ path, body }) =>
								path === "/question/question/reply" &&
								JSON.stringify(body) === JSON.stringify({ answers: [["yes"]] }),
						)
						.map(({ directory }) => directory),
				)
				.toContain(`/stored/${call.sessionId}`);
		}
		const first = calls[0];
		if (!first) throw new Error("Missing first call");
		const unrouted = new OpenCodeProviderInstance({});
		const unbound = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(undefined),
		});
		for (const operation of [
			provider.discoverEffect("/projects/one"),
			provider.discoverEffect(undefined, first.account),
			unrouted.discoverEffect("/projects/one", {
				...first.account,
				id: AccountIdSchema.make("opencode"),
			}),
			unrouted.resolvePermissionEffect(first.sessionId, "permission", "once"),
			unrouted.resolveQuestionEffect(first.sessionId, "question", {
				choice: "yes",
			}),
			unbound.resolvePermissionEffect(first.sessionId, "permission", "once"),
			unbound.resolveQuestionEffect(first.sessionId, "question", {
				choice: "yes",
			}),
		]) {
			const result = await Effect.runPromise(Effect.result(operation));
			expect.soft(result._tag).toBe("Failure");
		}
		expect(requests.filter(({ account }) => account === "default")).toEqual([]);
	});

	it.each([
		"once",
		"reject",
		"always",
		"question",
	] as const)("rejects %s replies with an empty stored directory and retries after it is restored", async (reply) => {
		const call: ProviderCall = {
			projectId: "one",
			sessionId: "a-one",
			account: {
				id: AccountIdSchema.make("a"),
				name: "a",
				driver: "opencode",
				usageEligible: false,
			},
			workspaceRoot: "/projects/one",
			extraFolders: [],
			shellEnv: {},
		};
		const operation =
			reply === "question"
				? provider.resolveQuestionEffect(
						call.sessionId,
						"question",
						{ choice: "yes" },
						call,
					)
				: provider.resolvePermissionEffect(
						call.sessionId,
						"permission",
						reply,
						undefined,
						call,
					);
		storedDirectory = "";
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await Effect.runPromise(Effect.result(operation));
			expect.soft(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect.soft(result.failure).toMatchObject({
					_tag: "ProviderInstanceFailure",
					operation:
						reply === "question" ? "resolveQuestion" : "resolvePermission",
					cause: new Error('OpenCode session "a-one" has no stored directory'),
				});
			}
		}
		expect
			.soft(requests.filter(({ path }) => path === "/session/a-one"))
			.toHaveLength(2);
		expect
			.soft(
				requests.filter(
					({ method }) => method === "POST" || method === "PATCH",
				),
			)
			.toEqual([]);

		storedDirectory = "/stored/a-one";
		await Effect.runPromise(operation);
		const replies = requests.filter(({ method }) => method === "POST");
		expect(replies).toHaveLength(1);
		expect(replies[0]).toMatchObject({
			account: "a",
			directory: "/stored/a-one",
			headerDirectory: null,
		});
		expect(requests.filter(({ account }) => account !== "a")).toEqual([]);
	});

	it.each([
		"permission",
		"question",
	] as const)("does not reply after interrupting a %s session lookup and allows a fresh attempt", async (reply) => {
		const instances = await runtime.runPromise(OpenCodeInstancesTag);
		const bound = new OpenCodeProviderInstance({
			clientForSession: () => instances.use("a", "/projects/one"),
		});
		const operation =
			reply === "permission"
				? bound.resolvePermissionEffect("a-one", "permission", "once")
				: bound.resolveQuestionEffect("a-one", "question", { choice: "yes" });
		let releaseRead = () => {};
		const pending = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const started = new Promise<void>((resolve) => {
			sessionRead = () => {
				resolve();
				return pending;
			};
		});
		const fiber = Effect.runFork(operation);
		try {
			await started;
			await Effect.runPromise(Fiber.interrupt(fiber));
		} finally {
			sessionRead = undefined;
			releaseRead();
		}
		await Effect.runPromise(operation);
		expect(
			requests.filter(({ path }) => path === "/session/a-one"),
		).toHaveLength(2);
		const writes = requests.filter(
			({ method }) => method === "POST" || method === "PATCH",
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			account: "a",
			directory: "/stored/a-one",
		});
	});
});
