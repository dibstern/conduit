import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ClaudeProviderInstance } from "../../../../src/lib/provider/claude/claude-provider-instance.js";
import { makeClaudeProviderRuntime } from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import type {
	Query,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import { getClaudeRuntimeSessionCountForTest } from "../../../helpers/claude-runtime-state.js";
import { makeBaseSendTurnInput } from "../../../helpers/mock-sdk.js";

const REPO_ROOT = process.cwd();
const CLAUDE_PROVIDER_DIR = "src/lib/provider/claude";

const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

function makeBlockingQuery(
	streamStarted: Deferred.Deferred<void>,
	releaseStream: Deferred.Deferred<void>,
): Query {
	const release = async () => {
		await Effect.runPromise(Deferred.succeed(releaseStream, undefined));
	};
	const stream = {
		async next() {
			await Effect.runPromise(Deferred.succeed(streamStarted, undefined));
			await Effect.runPromise(Deferred.await(releaseStream));
			return { done: true, value: undefined };
		},
		async return() {
			await release();
			return { done: true, value: undefined };
		},
		async throw(error?: unknown) {
			throw error;
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	} as AsyncGenerator<SDKMessage, void, unknown>;

	return Object.assign(stream, {
		interrupt: vi.fn(release),
		close: vi.fn(() => {
			Effect.runFork(Deferred.succeed(releaseStream, undefined));
		}),
		setModel: vi.fn(async () => {}),
		setPermissionMode: vi.fn(async () => {}),
		streamInput: vi.fn(async () => {}),
		setMaxThinkingTokens: vi.fn(async () => {}),
		applyFlagSettings: vi.fn(async () => {}),
		initializationResult: vi.fn(async () => ({})),
		supportedCommands: vi.fn(async () => []),
		supportedModels: vi.fn(async () => []),
		supportedAgents: vi.fn(async () => []),
		mcpServerStatus: vi.fn(async () => []),
		getContextUsage: vi.fn(async () => ({})),
		reloadPlugins: vi.fn(async () => ({})),
		accountInfo: vi.fn(async () => ({})),
		rewindFiles: vi.fn(async () => ({ canRewind: false })),
		seedReadState: vi.fn(async () => {}),
		reconnectMcpServer: vi.fn(async () => {}),
		toggleMcpServer: vi.fn(async () => {}),
		setMcpServers: vi.fn(async () => ({})),
		stopTask: vi.fn(async () => {}),
		next: stream.next.bind(stream),
		return: stream.return.bind(stream),
		throw: stream.throw.bind(stream),
		[Symbol.asyncIterator]: () => stream,
	}) as unknown as Query;
}

describe("Claude provider runtime boundary", () => {
	it("keeps live Claude turn state out of the provider instance facade", () => {
		const providerInstance = source(
			`${CLAUDE_PROVIDER_DIR}/claude-provider-instance.ts`,
		);

		expect(providerInstance).toContain("ClaudeProviderRuntime");
		expect(providerInstance).not.toContain("sessions = new Map");
		expect(providerInstance).not.toContain("sessionLocks");
		expect(providerInstance).not.toContain("turnDeferredQueues");
		expect(providerInstance).not.toContain("endedSessionStreams");
	});

	it("keeps Claude runtime state Effect-owned", () => {
		const runtime = source(`${CLAUDE_PROVIDER_DIR}/claude-provider-runtime.ts`);

		expect(runtime).toContain("ClaudeProviderRuntimeTag");
		expect(runtime).toContain("Ref.Ref<ClaudeProviderRuntimeState>");
		expect(runtime).toContain("HashMap.HashMap<string, ClaudeSessionContext>");
		expect(runtime).toContain("FiberMap.FiberMap<string");
		expect(runtime).not.toContain("streamConsumer");
	});

	it("removes stream consumer promises from session context", () => {
		const types = source(`${CLAUDE_PROVIDER_DIR}/types.ts`);

		expect(types).not.toContain("streamConsumer");
	});

	it("closes active SDK sessions from the scoped runtime finalizer", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const streamStarted = yield* Deferred.make<void>();
				const releaseStream = yield* Deferred.make<void>();
				const query = makeBlockingQuery(streamStarted, releaseStream);
				const scope = yield* Scope.make();
				const runtime = yield* makeClaudeProviderRuntime({
					workspaceRoot: "/tmp/ws",
					queryFactory: () => query,
				}).pipe(Effect.provideService(Scope.Scope, scope));
				const instance = new ClaudeProviderInstance(runtime);

				const turnFiber = yield* Effect.fork(
					instance
						.sendTurnEffect(
							makeBaseSendTurnInput({ sessionId: "scoped-shutdown" }),
						)
						.pipe(Effect.either),
				);
				yield* Deferred.await(streamStarted).pipe(
					Effect.timeoutFail({
						duration: "1 second",
						onTimeout: () => new Error("Claude stream did not start"),
					}),
				);

				yield* Scope.close(scope, Exit.void);
				const turnResult = yield* Fiber.join(turnFiber);

				expect(query.interrupt).toHaveBeenCalledTimes(1);
				expect(query.close).toHaveBeenCalledTimes(1);
				expect(getClaudeRuntimeSessionCountForTest(instance)).toBe(0);
				expect(turnResult._tag).toBe("Left");
			}),
		);
	});
});
