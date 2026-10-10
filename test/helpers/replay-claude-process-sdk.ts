import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeClaudeSDKMessage } from "../../src/lib/contracts/providers/claude-agent-sdk.js";
import {
	type ClaudeTraceName,
	type ClaudeTraceReplayer,
	createClaudeTraceReplayer,
} from "../e2e/helpers/claude-trace-replayer.js";
import { claudeSdk as fakeSdk } from "./fake-claude-process-sdk.js";

export {
	claudeSubagentSdk,
	resolveSettings,
} from "./fake-claude-process-sdk.js";

// The server imports this module too. Only per-session runners play turns.
const isRunner = /claude-session-runner\.(js|ts)$/.test(process.argv[1] ?? "");
let replayer: ClaudeTraceReplayer | undefined;

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
		if (!isRunner || params.options?.maxTurns === 0)
			return fakeSdk.query(params);

		if (!replayer) {
			const turns = process.env["CONDUIT_TEST_CLAUDE_REPLAY_TURNS"];
			if (!turns) throw new Error("Claude replay requires a turn plan");
			replayer = createClaudeTraceReplayer({
				turns: JSON.parse(turns) as readonly ClaudeTraceName[],
				delayMs: Number(
					process.env["CONDUIT_TEST_CLAUDE_REPLAY_DELAY_MS"] ?? 0,
				),
			});
		}
		// Reuse fake SDK initialization without giving it the runner's prompt queue.
		// The replayer consumes a turn only when that queue receives a real prompt.
		const initialization = fakeSdk.query({
			...params,
			prompt: (async function* () {
				yield* [];
			})(),
		});
		const query = replayer.sdk.query(params);
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
				const enterPath = process.env["CONDUIT_TEST_CLAUDE_REPLAY_ENTER_PATH"];
				let wire = JSON.stringify(message);
				if (enterPath)
					wire = wire.replaceAll(
						"/tmp/conduit-worktree-capture/repo/.claude/worktrees/contract",
						enterPath,
					);
				if (project)
					wire = wire.replaceAll("/tmp/conduit-worktree-capture/repo", project);
				const mapped = decodeClaudeSDKMessage(JSON.parse(wire));
				return {
					done: false as const,
					value:
						mapped.type === "system" && mapped.subtype === "init"
							? {
									...mapped,
									cwd:
										process.env["CONDUIT_TEST_CLAUDE_REPLAY_CWD"] ??
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
