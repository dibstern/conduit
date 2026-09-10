// Conduit's session permission modes map 1:1 onto the SDK's six. The mapping
// has to be bijective in both directions: the forward half is what the session
// actually enforces, and the reverse half is what lets conduit trust the mode
// the SDK reports back on each turn's init message.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCapabilitiesService } from "../../../../src/lib/provider/claude/claude-capabilities-service.js";
import { ClaudeProviderInstance } from "../../../../src/lib/provider/claude/claude-provider-instance.js";
import type {
	Query,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { ModelInfo } from "../../../../src/lib/provider/types.js";
import type { SessionPermissionMode } from "../../../../src/lib/shared-types.js";
import {
	createMockEventSink,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

const SONNET = "claude-sonnet-4-6";

function makeCapabilitiesService(): ClaudeCapabilitiesService {
	const model: ModelInfo = {
		id: SONNET,
		name: SONNET,
		providerId: "claude",
		resolvedModel: SONNET,
	};
	return {
		get: vi.fn(() =>
			Effect.succeed({ models: [model], commands: [], agents: [] }),
		),
	};
}

function makeMockQuery(gen: AsyncGenerator<SDKMessage, void, unknown>) {
	const setPermissionMode = vi.fn(async () => {});
	const query = Object.assign(gen, {
		interrupt: vi.fn(async () => {}),
		close: vi.fn(),
		setModel: vi.fn(async () => {}),
		setPermissionMode,
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
		next: gen.next.bind(gen),
		return: gen.return.bind(gen),
		throw: gen.throw.bind(gen),
		[Symbol.asyncIterator]: () => gen,
	}) as unknown as Query;
	return { query, setPermissionMode };
}

const singleTurn = () =>
	(async function* () {
		yield makeSuccessResult({ session_id: "sdk-1" }) as unknown as SDKMessage;
	})();

/** conduit mode -> the SDK mode the live query must actually be put into. */
const FORWARD: ReadonlyArray<readonly [SessionPermissionMode, string]> = [
	["ask", "default"],
	["acceptEdits", "acceptEdits"],
	["full", "bypassPermissions"],
	["auto", "auto"],
	["plan", "plan"],
	["dontAsk", "dontAsk"],
];

describe("Claude permission mode mapping", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-perm-map-${Date.now()}`);
		mkdirSync(workspace, { recursive: true });
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	for (const [conduitMode, sdkMode] of FORWARD) {
		it(`puts the live query into "${sdkMode}" for conduit "${conduitMode}"`, async () => {
			const { query, setPermissionMode } = makeMockQuery(singleTurn());
			const instance = new ClaudeProviderInstance({
				workspaceRoot: workspace,
				queryFactory: vi.fn(() => query),
				capabilitiesService: makeCapabilitiesService(),
			});

			const turn = await Effect.runPromise(
				instance.sendTurnEffect(
					makeBaseSendTurnInput({
						sessionId: "s1",
						turnId: "turn-1",
						eventSink: createMockEventSink(),
						model: { providerId: "claude", modelId: SONNET },
					}),
				),
			);
			expect(turn.status).toBe("completed");

			await Effect.runPromise(
				instance.setPermissionModeEffect("s1", conduitMode),
			);
			expect(setPermissionMode).toHaveBeenCalledWith(sdkMode);
		});
	}

	it("starts a bypassPermissions session with the dangerous-skip flag set", async () => {
		const { query } = makeMockQuery(singleTurn());
		let createdOptions:
			| { permissionMode?: string; allowDangerouslySkipPermissions?: boolean }
			| undefined;
		const queryFactory = vi.fn(
			(args: {
				options?: {
					permissionMode?: string;
					allowDangerouslySkipPermissions?: boolean;
				};
			}) => {
				createdOptions = args.options;
				return query;
			},
		);
		const instance = new ClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory,
			capabilitiesService: makeCapabilitiesService(),
		});

		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "s1",
					turnId: "turn-1",
					eventSink: createMockEventSink(),
					model: { providerId: "claude", modelId: SONNET },
					permissionMode: "full",
				}),
			),
		);

		// The SDK refuses bypassPermissions unless the caller opts in explicitly.
		expect(createdOptions?.permissionMode).toBe("bypassPermissions");
		expect(createdOptions?.allowDangerouslySkipPermissions).toBe(true);
	});

	it("does not set the dangerous-skip flag for any other mode", async () => {
		const { query } = makeMockQuery(singleTurn());
		let createdOptions:
			| { permissionMode?: string; allowDangerouslySkipPermissions?: boolean }
			| undefined;
		const instance = new ClaudeProviderInstance({
			workspaceRoot: workspace,
			queryFactory: vi.fn(
				(args: {
					options?: {
						permissionMode?: string;
						allowDangerouslySkipPermissions?: boolean;
					};
				}) => {
					createdOptions = args.options;
					return query;
				},
			),
			capabilitiesService: makeCapabilitiesService(),
		});

		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "s1",
					turnId: "turn-1",
					eventSink: createMockEventSink(),
					model: { providerId: "claude", modelId: SONNET },
					permissionMode: "acceptEdits",
				}),
			),
		);

		expect(createdOptions?.permissionMode).toBe("acceptEdits");
		expect(createdOptions?.allowDangerouslySkipPermissions).toBeUndefined();
	});
});
