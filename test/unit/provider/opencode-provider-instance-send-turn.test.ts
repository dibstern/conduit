// test/unit/provider/opencode-provider-instance-send-turn.test.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentRefSchema } from "../../../src/lib/contracts/attachment-ref.js";
import {
	AccountIdSchema,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "../../../src/lib/contracts/provider-instance.js";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { OpenCodeApiError } from "../../../src/lib/errors.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type {
	PermissionRuleset,
	SessionDetail,
} from "../../../src/lib/instance/sdk-types.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import type {
	EventSink,
	ResolvedSendTurnInput,
	TurnResult,
} from "../../../src/lib/provider/types.js";

function makeStubClient(overrides?: Record<string, unknown>): OpenCodeAPI {
	return {
		permission: { reply: vi.fn(async () => {}), list: vi.fn(async () => []) },
		question: {
			reply: vi.fn(async () => {}),
			reject: vi.fn(async () => {}),
			list: vi.fn(async () => []),
		},
		provider: {
			list: vi.fn(async () => ({
				providers: [],
				defaults: {},
				connected: [],
			})),
		},
		app: {
			agents: vi.fn(async () => []),
			commands: vi.fn(async () => []),
			skills: vi.fn(async () => []),
		},
		...overrides,
		session: {
			get: vi.fn(async () => ({ permission: [] })),
			messages: vi.fn(async () => []),
			statuses: vi.fn(async () => ({})),
			update: vi.fn(async () => {}),
			prompt: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			...(overrides?.["session"] as Record<string, unknown>),
		},
	} as unknown as OpenCodeAPI;
}

function makeStubEventSink(): EventSink & {
	pushedEvents: ProviderRuntimeEvent[];
} {
	const pushedEvents: ProviderRuntimeEvent[] = [];
	return {
		pushedEvents,
		push: vi.fn((event: ProviderRuntimeEvent) =>
			Effect.sync(() => {
				pushedEvents.push(event);
			}),
		),
		requestPermission: vi.fn(() =>
			Effect.succeed({
				decision: "once" as const,
			}),
		),
		requestQuestion: vi.fn(() => Effect.succeed({})),
		resolvePermission: vi.fn(() => Effect.void),
		resolveQuestion: vi.fn(() => Effect.void),
	};
}

function makeSendTurnInput(
	overrides?: Partial<ResolvedSendTurnInput>,
): ResolvedSendTurnInput {
	return {
		sessionId: "s1",
		inputId: "t1",
		awaitIntake: Effect.succeed({
			status: "accepted",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		}),
		prompt: "Write hello world",
		history: [],
		providerState: {},
		model: { providerId: "anthropic", modelId: "claude-sonnet" },
		workspaceRoot: "/tmp/project",
		extraFolders: [],
		eventSink: makeStubEventSink(),
		abortSignal: new AbortController().signal,
		...overrides,
	};
}

it("keeps overlapping compaction calls one-to-one without claiming ordinary echoes", async () => {
	let finishA = () => {};
	let finishB = () => {};
	const heldA = new Promise<void>((resolve) => {
		finishA = resolve;
	});
	const heldB = new Promise<void>((resolve) => {
		finishB = resolve;
	});
	const summarize = vi
		.fn()
		.mockImplementationOnce(() => heldA)
		.mockImplementationOnce(() => heldB);
	const instance = new OpenCodeProviderInstance({
		clientForSession: () =>
			Effect.succeed(makeStubClient({ session: { summarize } })),
	});
	const input = (inputId: string) =>
		makeSendTurnInput({
			inputId,
			prompt: "/compact",
			model: { providerId: "opencode", modelId: "model" },
		});
	const first = Effect.runPromise(instance.sendTurnEffect(input("a")));
	let second: Promise<TurnResult> | undefined;
	try {
		await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
		expect(instance.inputIdForUserEcho("s1", "ordinary-tui")).toBeUndefined();
		expect(instance.inputIdForUserEcho("s1", "compact-a", true)).toBe("a");
		// A's native result can settle its outbox before summarize returns.
		second = Effect.runPromise(instance.sendTurnEffect(input("b")));
		await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(2));
		expect(instance.inputIdForUserEcho("s1", "compact-a", true)).toBe("a");
		expect(instance.inputIdForUserEcho("s1", "compact-b", true)).toBe("b");
		expect(
			instance.inputIdForUserEcho("s1", "compact-third", true),
		).toBeUndefined();
	} finally {
		finishA();
		finishB();
		await Promise.all([first, second]);
	}
	// No bridge remains after either RPC returns.
	expect(instance.inputIdForUserEcho("s1", "compact-a", true)).toBeUndefined();
});

function expectDeliveryFailure(
	result: unknown,
	message: unknown,
	code = "SEND_FAILED",
) {
	expect(result).toMatchObject({
		_tag: "Failure",
		failure: { cause: { code, message, retryable: false } },
	});
}

describe("OpenCodeProviderInstance.sendTurn()", () => {
	let client: OpenCodeAPI;
	let instance: OpenCodeProviderInstance;

	it("returns at durable intake without waiting for a provider terminal", async () => {
		const intake = Deferred.makeUnsafe<TurnResult>();
		let returned = false;
		const resultPromise = Effect.runPromise(
			instance
				.sendTurnEffect(
					makeSendTurnInput({ awaitIntake: Deferred.await(intake) }),
				)
				.pipe(Effect.timeout("500 millis")),
		).then((result) => {
			returned = true;
			return result;
		});
		await vi.waitFor(() =>
			expect(client.session.prompt).toHaveBeenCalledOnce(),
		);
		expect(returned).toBe(false);
		const accepted: TurnResult = {
			status: "accepted",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		};
		Deferred.doneUnsafe(intake, Effect.succeed(accepted));
		await expect(resultPromise).resolves.toBe(accepted);
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t1")).toBe("t1");
	});

	beforeEach(() => {
		client = makeStubClient();
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
		});
	});

	it.each([
		"returned",
		"in flight",
	] as const)("returns indeterminate without native cancellation when prompt_async is %s", async (phase) => {
		const controller = new AbortController();
		const submitted = Deferred.makeUnsafe<void>();
		if (phase === "in flight")
			vi.mocked(client.session.prompt).mockImplementation(() =>
				Effect.runPromise(Deferred.await(submitted)),
			);
		const result = Effect.runPromise(
			instance
				.sendTurnEffect(
					makeSendTurnInput({
						abortSignal: controller.signal,
						awaitIntake: Effect.never,
					}),
				)
				.pipe(Effect.timeout("500 millis")),
		);
		await vi.waitFor(() =>
			expect(client.session.prompt).toHaveBeenCalledOnce(),
		);
		controller.abort();
		await expect(result).resolves.toMatchObject({ status: "indeterminate" });
		expect(client.session.abort).not.toHaveBeenCalled();
		expect(client.session.messages).not.toHaveBeenCalled();
		expect(client.session.statuses).not.toHaveBeenCalled();
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t1")).toBe("t1");
		// The adapter retains no admission permit; durable run ownership gates later sends.
		Deferred.doneUnsafe(submitted, Effect.void);
		await expect(
			Effect.runPromise(
				instance.sendTurnEffect(makeSendTurnInput({ inputId: "t2" })),
			),
		).resolves.toMatchObject({ status: "accepted" });
	});

	it("recalls an input still in daemon preparation without sending it later", async () => {
		const controller = new AbortController();
		const prepared = Deferred.makeUnsafe<SessionDetail>();
		vi.mocked(client.session.get).mockImplementation(() =>
			Effect.runPromise(Deferred.await(prepared)),
		);
		const result = Effect.runPromise(
			instance
				.sendTurnEffect(
					makeSendTurnInput({
						abortSignal: controller.signal,
						awaitIntake: Effect.never,
					}),
				)
				.pipe(Effect.timeout("500 millis")),
		);
		await vi.waitFor(() => expect(client.session.get).toHaveBeenCalledOnce());
		controller.abort();
		await expect(result).resolves.toMatchObject({ status: "cancelled" });
		Deferred.doneUnsafe(
			prepared,
			Effect.succeed({
				id: "s1",
				projectID: "project",
				directory: "/tmp/project",
				title: "Session",
				version: "1",
				time: { created: 1, updated: 1 },
				permission: [],
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.session.prompt).not.toHaveBeenCalled();
		expect(client.session.abort).not.toHaveBeenCalled();
	});

	it("leaves a failed submitted RPC indeterminate without probing or aborting", async () => {
		vi.mocked(client.session.prompt).mockRejectedValue(
			new Error("prompt disconnected"),
		);
		await expect(
			Effect.runPromise(instance.sendTurnEffect(makeSendTurnInput())),
		).resolves.toMatchObject({ status: "indeterminate" });
		expect(client.session.abort).not.toHaveBeenCalled();
		expect(client.session.messages).not.toHaveBeenCalled();
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t1")).toBe("t1");
	});

	it("leaves a failed intake observation indeterminate without native cancellation", async () => {
		await expect(
			Effect.runPromise(
				instance.sendTurnEffect(
					makeSendTurnInput({
						awaitIntake: Effect.fail(
							new ProviderInstanceFailure({
								providerId: "opencode",
								operation: "awaitIntake",
								cause: new Error("intake disconnected"),
							}),
						),
					}),
				),
			),
		).resolves.toMatchObject({ status: "indeterminate" });
		expect(client.session.abort).not.toHaveBeenCalled();
		expect(client.session.messages).not.toHaveBeenCalled();
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t1")).toBe("t1");
	});

	it("dispatches the prompt before returning accepted intake", async () => {
		const input = makeSendTurnInput();
		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));

		const result = await resultPromise;
		expect(client.session.prompt).toHaveBeenCalledWith("s1", {
			directory: "/tmp/project",
			messageId: "msg_conduit_t1",
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
		});
		expect(result.status).toBe("accepted");
		expect(client.session.update).not.toHaveBeenCalled();
	});

	it.each([
		{ action: "allow", desired: true },
		{ action: "deny", desired: true },
		{ action: "ask", desired: true },
		{ action: "allow", desired: false },
		{ action: "deny", desired: false },
		{ action: "ask", desired: false },
	] as const)("reconciles the last $action rule with desired=$desired without touching catch-alls", async ({
		action,
		desired,
	}) => {
		const extra = mkdtempSync(
			join(realpathSync(tmpdir()), "usg5-7-permission-"),
		);
		try {
			const pattern = `${extra}/*`;
			const permission: PermissionRuleset = [
				{ permission: "read", pattern, action: "allow" },
				{ permission: "external_directory", pattern: "*", action: "allow" },
				{ permission: "external_directory", pattern, action: "allow" },
				{ permission: "external_directory", pattern, action },
			];
			client = makeStubClient({
				session: { get: vi.fn(async () => ({ permission })) },
			});
			instance = new OpenCodeProviderInstance({
				clientForSession: () => Effect.succeed(client),
			});
			const resultPromise = Effect.runPromise(
				instance.sendTurnEffect(
					makeSendTurnInput({ extraFolders: desired ? [extra, extra] : [] }),
				),
			);
			expect((await resultPromise).status).toBe("accepted");
			expect(client.session.get).toHaveBeenCalledWith("s1");
			if (desired !== (action === "allow")) {
				expect(client.session.update).toHaveBeenCalledExactlyOnceWith("s1", {
					permission: [
						{
							permission: "external_directory",
							pattern,
							action: desired ? "allow" : "ask",
						},
					],
				});
			} else {
				expect(client.session.update).not.toHaveBeenCalled();
			}
		} finally {
			rmSync(extra, { recursive: true, force: true });
		}
	});

	it.each([
		"disappeared-folder",
		"literal*folder",
		"literal?folder",
	])("prompts without granting access to a %s", async (name) => {
		const root = mkdtempSync(
			join(realpathSync(tmpdir()), "usg5-7-permission-"),
		);
		const extra = join(root, name);
		if (name !== "disappeared-folder") mkdirSync(extra);
		try {
			const resultPromise = Effect.runPromise(
				instance.sendTurnEffect(makeSendTurnInput({ extraFolders: [extra] })),
			);
			expect((await resultPromise).status).toBe("accepted");
			expect(client.session.update).not.toHaveBeenCalled();
			expect(client.session.prompt).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({ system: expect.stringContaining(extra) }),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("tags only exact reserved user echoes, regardless of echo order", async () => {
		const sends = [
			makeSendTurnInput({ inputId: "t1", prompt: "same" }),
			makeSendTurnInput({ inputId: "t2", prompt: "same" }),
			makeSendTurnInput({ sessionId: "s2", inputId: "other", prompt: "same" }),
		].map((input) => Effect.runPromise(instance.sendTurnEffect(input)));
		await vi.waitFor(() => {
			expect(client.session.prompt).toHaveBeenCalledTimes(3);
		});

		expect(instance.inputIdForUserEcho("s1", "msg_native")).toBeUndefined();
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t2")).toBe("t2");
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t1")).toBe("t1");
		expect(instance.inputIdForUserEcho("s2", "msg_conduit_other")).toBe(
			"other",
		);

		await Promise.all(sends);
		// Replayed echoes keep their correlation after intake returns.
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t1")).toBe("t1");
	});

	it("keeps exact echo bindings after an earlier submitted prompt becomes indeterminate", async () => {
		let rejectFirstPrompt: ((error: Error) => void) | undefined;
		const prompt = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectFirstPrompt = reject;
					}),
			)
			.mockResolvedValueOnce(undefined);
		client = makeStubClient({
			session: {
				prompt,
				abort: vi.fn(async () => {}),
			},
		});
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
		});

		const firstResultPromise = Effect.runPromise(
			instance
				.sendTurnEffect(makeSendTurnInput({ inputId: "t1", prompt: "first" }))
				.pipe(Effect.result),
		);
		await vi.waitFor(() => {
			expect(prompt).toHaveBeenCalledTimes(1);
		});

		const secondResultPromise = Effect.runPromise(
			instance
				.sendTurnEffect(makeSendTurnInput({ inputId: "t2", prompt: "second" }))
				.pipe(
					Effect.timeoutOrElse({
						duration: "500 millis",
						orElse: () =>
							Effect.fail(
								(() =>
									new Error("joined prompt was evicted by stale cleanup"))(),
							),
					}),
				),
		);
		rejectFirstPrompt?.(new Error("first prompt failed"));
		const firstResult = await firstResultPromise;
		expect(firstResult).toMatchObject({
			_tag: "Success",
			success: { status: "indeterminate" },
		});
		await vi.waitFor(() => {
			expect(prompt).toHaveBeenCalledTimes(2);
		});

		expect((await secondResultPromise).status).toBe("accepted");
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t2")).toBe("t2");
		expect(instance.inputIdForUserEcho("s1", "msg_conduit_t1")).toBe("t1");
	});

	it("passes images and agent to sendMessageAsync", async () => {
		const input = makeSendTurnInput({
			images: [
				{
					ref: Schema.decodeUnknownSync(AttachmentRefSchema)({
						attachmentHash: "a".repeat(64),
						mime: "image/png",
					}),
					dataUrl: "data:image/png;base64,abc",
				},
			],
			agent: "coder",
		});

		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));

		await resultPromise;

		expect(client.session.prompt).toHaveBeenCalledWith("s1", {
			directory: "/tmp/project",
			messageId: "msg_conduit_t1",
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		});
	});

	it.each([
		{
			session: "a regular session",
			input: { agent: "coder" },
			expected: { agent: "plan" },
		},
		{
			session: "a Side Thread with a picked agent",
			input: { sideThread: true, agent: "coder" },
			expected: { agent: "coder" },
		},
		{
			session: "a Side Thread without a picked agent",
			input: { sideThread: true },
			expected: {},
		},
	])("respects plan agent selection for $session", async ({
		input,
		expected,
	}) => {
		const resultPromise = Effect.runPromise(
			instance.sendTurnEffect(
				makeSendTurnInput({ permissionMode: "plan", ...input }),
			),
		);
		await resultPromise;

		expect(client.session.prompt).toHaveBeenCalledExactlyOnceWith("s1", {
			directory: "/tmp/project",
			messageId: "msg_conduit_t1",
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
			...expected,
		});
	});

	it("passes variant to sendMessageAsync", async () => {
		const input = makeSendTurnInput({ variant: "thinking" });

		const resultPromise = Effect.runPromise(instance.sendTurnEffect(input));

		await resultPromise;

		expect(client.session.prompt).toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({
				variant: "thinking",
			}),
		);
	});

	it("fails through the typed channel when session preparation fails", async () => {
		client = makeStubClient({
			session: {
				get: vi.fn(async () => {
					throw new Error("HTTP 500");
				}),
				abort: vi.fn(async () => {}),
			},
		});
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
		});

		const input = makeSendTurnInput();
		const result = await Effect.runPromise(
			instance.sendTurnEffect(input).pipe(Effect.result),
		);

		expectDeliveryFailure(result, expect.stringContaining("HTTP 500"));
	});

	it.each([
		"before delivery",
		"during HTTP prompt",
	] as const)("distinguishes local recall from uncertain submission when aborted %s", async (phase) => {
		const abortController = new AbortController();
		client = makeStubClient({
			session: {
				prompt: vi.fn(async () => {
					abortController.abort();
				}),
			},
		});
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
		});
		if (phase === "before delivery") abortController.abort();
		const input = makeSendTurnInput({ abortSignal: abortController.signal });
		const result = await Effect.runPromise(
			instance.sendTurnEffect(input).pipe(Effect.result),
		);
		expect(result).toMatchObject({
			_tag: "Success",
			success: {
				status: phase === "before delivery" ? "cancelled" : "indeterminate",
			},
		});
		expect(client.session.prompt).toHaveBeenCalledTimes(
			phase === "before delivery" ? 0 : 1,
		);
		expect(client.session.abort).not.toHaveBeenCalled();
	});

	it("fails with SEND_FAILED (no hang) when the bound named instance cannot be resolved", async () => {
		instance = new OpenCodeProviderInstance({
			clientForSession: () =>
				Effect.fail(new Error('OpenCode instance "oc-b" is not configured')),
		});

		const result = await Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()).pipe(Effect.result),
		);

		expectDeliveryFailure(result, expect.stringContaining('"oc-b"'));
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	it("routes the prompt to the named instance client resolved for the session", async () => {
		const namedClient = makeStubClient();
		instance = new OpenCodeProviderInstance({
			clientForSession: (sessionId) =>
				Effect.succeed(sessionId === "s1" ? namedClient : undefined),
		});

		const resultPromise = Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()),
		);
		await resultPromise;

		expect(namedClient.session.prompt).toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({ text: "Write hello world" }),
		);
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	// A resolved default may differ from a deleted session binding. Never look
	// that binding up again or silently prompt the project-default server.
	it("routes the prompt through the carried OpenCode account", async () => {
		const account = {
			id: AccountIdSchema.make("current-opencode"),
			name: "Current OpenCode",
			driver: "opencode" as const,
			usageEligible: false as const,
			url: "http://test.invalid:4096",
		};
		const namedClient = makeStubClient();
		const clientForAccount = vi.fn(() => Effect.succeed(namedClient));
		const clientForSession = vi.fn(() =>
			Effect.fail(new Error("Historical binding must not be resolved")),
		);
		instance = new OpenCodeProviderInstance({
			clientForAccount,
			clientForSession,
		});
		const resultPromise = Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput({ account })),
		);
		expect((await resultPromise).status).toBe("accepted");
		expect(clientForAccount).toHaveBeenCalledExactlyOnceWith(
			account,
			"/tmp/project",
		);
		expect(clientForSession).not.toHaveBeenCalled();
		expect(namedClient.session.prompt).toHaveBeenCalledOnce();
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	it("retains an indeterminate submission on the named instance after transport failure", async () => {
		const namedClient = makeStubClient({
			session: {
				prompt: vi.fn(async () => {
					throw new Error("fetch failed: ECONNREFUSED");
				}),
				abort: vi.fn(async () => {}),
			},
		});
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(namedClient),
		});

		const result = await Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()).pipe(Effect.result),
		);

		expect(result).toMatchObject({
			_tag: "Success",
			success: { status: "indeterminate" },
		});
		expect(namedClient.session.abort).not.toHaveBeenCalled();
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	it("does not infer a named-instance migration from a stale facade URL after an endpoint change", async () => {
		const failure = new OpenCodeApiError({
			message: "HTTP 404: session not found",
			endpoint: "session.prompt",
			responseStatus: 404,
		});
		client = makeStubClient({
			getBaseUrl: () => "http://opencode.invalid:4100",
		});
		const freshClient = makeStubClient({
			getBaseUrl: () => "http://opencode.invalid:4200",
			session: {
				get: vi.fn(async () => {
					throw failure;
				}),
			},
		});
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(freshClient),
			instanceIdForSession: () => Effect.succeed(MANAGED_OPENCODE_ACCOUNT_ID),
		});

		const result = await Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()).pipe(Effect.result),
		);

		expectDeliveryFailure(result, failure.message);
		expect(freshClient.session.get).toHaveBeenCalledOnce();
		expect(freshClient.session.prompt).not.toHaveBeenCalled();
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	it("retains the migration diagnostic for an authoritative named-instance binding with the same URL", async () => {
		client = makeStubClient({
			getBaseUrl: () => "http://opencode.invalid:4100",
		});
		const namedClient = makeStubClient({
			getBaseUrl: () => "http://opencode.invalid:4100",
			session: {
				get: vi.fn(async () => {
					throw new OpenCodeApiError({
						message: "HTTP 404: session not found",
						endpoint: "session.prompt",
						responseStatus: 404,
					});
				}),
			},
		});
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(namedClient),
			instanceIdForSession: () => Effect.succeed("oc-b"),
		});

		const result = await Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()).pipe(Effect.result),
		);

		expectDeliveryFailure(
			result,
			expect.stringContaining("may predate named-instance routing"),
		);
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	it("fails delivery when the session client route is unavailable", async () => {
		instance = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(undefined),
		});

		const result = await Effect.runPromise(
			instance.sendTurnEffect(makeSendTurnInput()).pipe(Effect.result),
		);
		expectDeliveryFailure(result, 'OpenCode session "s1" has no client route');
		expect(client.session.prompt).not.toHaveBeenCalled();
	});
});
