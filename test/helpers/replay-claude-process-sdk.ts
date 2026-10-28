import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeClaudeSDKMessage } from "../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ClaudeSubagentSdk } from "../../src/lib/provider/claude/claude-subagent-materializer.js";
import {
	type ClaudeTraceName,
	type ClaudeTraceReplayer,
	createClaudeTraceReplayer,
} from "../e2e/helpers/claude-trace-replayer.js";
import { provisionalLimitReply } from "../fixtures/claude-sdk-traces/provisional-usage-limit-turn.js";
import {
	claudeSdk as fakeSdk,
	claudeSubagentSdk as fakeSubagentSdk,
} from "./fake-claude-process-sdk.js";

export { resolveSettings } from "./fake-claude-process-sdk.js";

// The server imports this module too. Only per-session runners play turns.
const isRunner = /claude-session-runner\.(js|ts)$/.test(process.argv[1] ?? "");
let replayer: ClaudeTraceReplayer | undefined;
let activeWorkspace: string | undefined;

export const claudeSubagentSdk: ClaudeSubagentSdk = {
	listSubagents: (...args) =>
		(process.env["CONDUIT_TEST_CLAUDE_REPLAY_SUBAGENT_READS"] === "1" &&
		replayer
			? replayer.sdk.subagentSdk
			: fakeSubagentSdk
		).listSubagents(...args),
	getSubagentMessages: (...args) =>
		(process.env["CONDUIT_TEST_CLAUDE_REPLAY_SUBAGENT_READS"] === "1" &&
		replayer
			? replayer.sdk.subagentSdk
			: fakeSubagentSdk
		).getSubagentMessages(...args),
};

export const claudeSdk: typeof fakeSdk = {
	titleQuery: fakeSdk.titleQuery,
	fork: fakeSdk.fork,
	query(params) {
		const file = process.env["CONDUIT_TEST_CLAUDE_OPTIONS_FILE"];
		if (!file) throw new Error("Claude replay requires an options file");
		const seen = new WeakSet<object>();
		const record = JSON.stringify(
			{ pid: process.pid, options: params.options ?? {} },
			(_key, value: unknown) => {
				if (typeof value === "bigint") return value.toString();
				if (typeof value === "object" && value !== null) {
					if (seen.has(value)) return undefined;
					seen.add(value);
				}
				return value;
			},
		);
		appendFileSync(file, `${record}\n`);
		const recordedOptions: { options: Record<string, unknown> } =
			JSON.parse(record);
		if (!isRunner || params.options?.maxTurns === 0)
			return fakeSdk.query(params);
		const workspaceMoves =
			process.env["CONDUIT_TEST_CLAUDE_REPLAY_WORKSPACE_MOVES"] === "1";
		const checkpoint = `${file}.${process.argv[3]}.workspace-replay`;
		const saved: { nextTurn: number; activeWorkspace?: string } =
			workspaceMoves && existsSync(checkpoint)
				? JSON.parse(readFileSync(checkpoint, "utf8"))
				: { nextTurn: 0 };
		let nextTurn = saved.nextTurn;
		if (!replayer) activeWorkspace = saved.activeWorkspace;
		const save = () =>
			writeFileSync(checkpoint, JSON.stringify({ nextTurn, activeWorkspace }));

		if (!replayer) {
			const turns = process.env["CONDUIT_TEST_CLAUDE_REPLAY_TURNS"];
			if (!turns) throw new Error("Claude replay requires a turn plan");
			// Every runner reads the same hold file, so a hold applies to each
			// Claude session that reaches that trace line.
			const holdFile = process.env["CONDUIT_TEST_CLAUDE_REPLAY_HOLD"];
			const readHold = () => {
				if (!holdFile) return undefined;
				try {
					return JSON.parse(readFileSync(holdFile, "utf8")) as {
						turn: number;
						message: number;
						id: number;
					};
				} catch {
					return undefined;
				}
			};
			// The hold the replayer last matched against, so a replacement cannot strand it.
			let lastHold: ReturnType<typeof readHold>;
			const tracesDir = process.env["CONDUIT_TEST_CLAUDE_REPLAY_TRACES_DIR"];
			const played = createClaudeTraceReplayer({
				...(tracesDir ? { tracesDir } : {}),
				turns: (JSON.parse(turns) as readonly ClaudeTraceName[]).slice(
					nextTurn,
				),
				delayMs: Number(
					process.env["CONDUIT_TEST_CLAUDE_REPLAY_DELAY_MS"] ?? 0,
				),
				get holdBefore() {
					lastHold = readHold();
					return lastHold ?? [];
				},
			});
			replayer = played;
			// Deleting or replacing the hold file releases whatever this runner holds.
			if (holdFile)
				void (async () => {
					for (;;) {
						await played.held();
						const hold = lastHold;
						appendFileSync(
							`${holdFile}.reached`,
							`${JSON.stringify({ pid: process.pid, hold, at: Date.now() })}\n`,
						);
						while (readHold()?.id === hold?.id && existsSync(holdFile))
							await sleep(10);
						played.release();
					}
				})();
		}
		// Reuse fake SDK initialization without giving it the runner's prompt queue.
		// The replayer consumes a turn only when that queue receives a real prompt.
		const initialization = fakeSdk.query({
			...params,
			prompt: (async function* () {
				yield* [];
			})(),
		});
		let directiveTarget: string | undefined;
		const query = replayer.sdk.query({
			...params,
			prompt: (async function* () {
				for await (const message of params.prompt) {
					const prompt =
						typeof message.message.content === "string"
							? message.message.content
							: message.message.content
									.flatMap((block) =>
										block.type === "text" ? [block.text] : [],
									)
									.join("\n");
					appendFileSync(
						file,
						`${JSON.stringify({ pid: process.pid, options: recordedOptions.options, prompt })}\n`,
					);
					const line = prompt.split("\n")[0] ?? "";
					const prefix =
						"[Conduit workspace move] Call EnterWorktree with path ";
					directiveTarget =
						workspaceMoves && line.startsWith(prefix)
							? (JSON.parse(
									line.slice(prefix.length, -" before continuing.".length),
								) as string)
							: undefined;
					nextTurn += 1;
					if (workspaceMoves) save();
					yield message;
				}
			})(),
		});
		const nextReplay = query.next.bind(query);
		const closeReplay = query.close.bind(query);
		let closed = false;
		return Object.assign(query, {
			next: async (...args: Parameters<typeof query.next>) => {
				const next = await nextReplay(...args);
				if (next.done) return next;
				const message = next.value;
				const release =
					process.env["CONDUIT_TEST_CLAUDE_REPLAY_RESULT_RELEASE"];
				while (
					message.type === "result" &&
					release &&
					!closed &&
					!existsSync(release)
				)
					await sleep(10);
				const project = process.env["CONDUIT_TEST_CLAUDE_REPLAY_PROJECT_DIR"];
				const enterPath =
					directiveTarget ??
					process.env["CONDUIT_TEST_CLAUDE_REPLAY_ENTER_PATH"];
				let wire = JSON.stringify(message);
				// Workspace confirmations reuse a captured turn; each tool call is distinct.
				if (workspaceMoves)
					wire = wire.replaceAll(
						/toolu_[A-Za-z0-9]+/g,
						`$&-workspace-${nextTurn}`,
					);
				if (enterPath)
					wire = wire.replaceAll(
						"/tmp/conduit-worktree-capture/repo/.claude/worktrees/contract",
						enterPath,
					);
				if (project)
					wire = wire.replaceAll("/tmp/conduit-worktree-capture/repo", project);
				const mapped = decodeClaudeSDKMessage(JSON.parse(wire));
				if (
					mapped.type === "result" &&
					nextTurn ===
						Number(process.env["CONDUIT_TEST_CLAUDE_REPLAY_USAGE_LIMIT_TURN"])
				)
					return {
						done: false as const,
						value: decodeClaudeSDKMessage({
							...mapped,
							is_error: true,
							result: provisionalLimitReply,
							terminal_reason: "blocking_limit",
						}),
					};
				if (
					workspaceMoves &&
					mapped.type === "user" &&
					mapped.tool_use_result &&
					typeof mapped.tool_use_result === "object"
				) {
					if ("originalCwd" in mapped.tool_use_result)
						activeWorkspace = undefined;
					else if (
						"worktreePath" in mapped.tool_use_result &&
						typeof mapped.tool_use_result.worktreePath === "string"
					)
						activeWorkspace = mapped.tool_use_result.worktreePath;
					save();
				}
				return {
					done: false as const,
					value:
						mapped.type === "system" && mapped.subtype === "init"
							? {
									...mapped,
									cwd:
										process.env["CONDUIT_TEST_CLAUDE_REPLAY_CWD"] ??
										(workspaceMoves ? activeWorkspace : undefined) ??
										params.options?.cwd ??
										mapped.cwd,
								}
							: mapped,
				};
			},
			initializationResult: () => initialization.initializationResult(),
			close: () => {
				closed = true;
				initialization.close();
				closeReplay();
			},
		});
	},
};
