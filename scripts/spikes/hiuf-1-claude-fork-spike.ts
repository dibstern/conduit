/** Throwaway real-CLI experiment. Run: node --import tsx scripts/spikes/hiuf-1-claude-fork-spike.ts */
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	forkSession,
	type Options,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

type Row = Record<string, unknown>;
type Transcript = {
	file: string;
	sha256: string;
	records: { line: number; raw: Row }[];
};
type Launch = {
	label: string;
	prompts: string[];
	options: Partial<Options>;
	messages: SDKMessage[];
	inputs: { uuid: string; text: string; afterMessage: number }[];
	stderr: string[];
	stop: string;
	error?: string;
	sessionId?: string;
	createdFiles: string[];
	filesBefore: string[];
	filesAfter: string[];
	transcripts: Transcript[];
};
type Scenario = {
	scenario: string;
	evidence: string[];
	launches: Launch[];
	createdFiles: string[];
	filesBefore: string[];
	filesAfter: string[];
	error?: string;
	details: Row;
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(repo, "docs/performance/hiuf-1-claude-fork-spike");
const runId = randomUUID();
const scratch = join("/tmp/hiuf-1-spike-cwd", runId);
await mkdir(scratch, { recursive: true });
await mkdir(output, { recursive: true });
const cwd = await realpath(scratch);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const roots = [
	...new Set(
		[configDir, join(homedir(), ".claude")].flatMap((base) =>
			[cwd, scratch].map((path) =>
				join(base, "projects", path.replace(/[^a-zA-Z0-9]/g, "-")),
			),
		),
	),
];
const sdkDir = dirname(
	fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")),
);
const sdkVersion = JSON.parse(
	await readFile(join(sdkDir, "package.json"), "utf8"),
).version as string;
const bundledCli = JSON.parse(
	await readFile(join(sdkDir, "manifest.json"), "utf8"),
) as Row;
const environment = {
	runId,
	startedAt: new Date().toISOString(),
	cwd,
	scratch,
	configDir,
	claudeConfigDirUnchanged: true,
	transcriptRoots: roots,
	sdkVersion,
	bundledCliVersion: bundledCli.version,
	node: process.version,
	model: "sonnet",
	docs: "https://code.claude.com/docs/en/agent-sdk/sessions",
};
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const must = <T>(value: T | undefined, what: string): T => {
	if (value === undefined) throw new Error(`missing ${what}`);
	return value;
};
const errorText = (error: unknown) =>
	error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const shape = (message: SDKMessage) =>
	message.type + ("subtype" in message ? `/${message.subtype}` : "");
const textOf = (messages: SDKMessage[]) =>
	messages
		.filter((m) => m.type === "assistant")
		.flatMap((m) =>
			m.message.content.filter((b) => b.type === "text").map((b) => b.text),
		)
		.join("\n");
const modelReply = (message: SDKMessage) =>
	message.type === "assistant" && message.message.model !== "<synthetic>";
// 0.3.301 emits local commands as synthetic assistant records, despite the narrower .d.ts union.
const localRecord = (message: SDKMessage) =>
	message.type === "assistant" &&
	message.message.model === "<synthetic>" &&
	"local_command_source" in message;
const goalRows = (transcript: Transcript | undefined) =>
	transcript?.records.filter(
		({ raw }) =>
			raw.type === "attachment" &&
			(raw.attachment as Row | undefined)?.type === "goal_status",
	) ?? [];
const succeeded = (launch: Launch) =>
	launch.messages.some((m) => m.type === "result" && m.subtype === "success");
const sleepUse = (message: SDKMessage) =>
	message.type === "assistant" &&
	message.message.content.some(
		(b) =>
			b.type === "tool_use" && JSON.stringify(b.input).includes("sleep 20"),
	);

async function files(): Promise<string[]> {
	return (
		await Promise.all(
			roots.map(async (root) => {
				try {
					return (await readdir(root))
						.filter((name) => name.endsWith(".jsonl"))
						.map((name) => join(root, name));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
					throw error;
				}
			}),
		)
	)
		.flat()
		.sort();
}

async function transcripts(ids: string[]): Promise<Transcript[]> {
	const found: Transcript[] = [];
	for (const file of await files()) {
		if (!ids.some((id) => file.endsWith(`/${id}.jsonl`))) continue;
		const content = await readFile(file, "utf8");
		const records = content.split("\n").flatMap((line, i) => {
			if (!line.trim()) return [];
			try {
				return [{ line: i + 1, raw: JSON.parse(line) as Row }];
			} catch {
				return [{ line: i + 1, raw: { parseError: true, text: line } }];
			}
		});
		found.push({
			file,
			sha256: createHash("sha256").update(content).digest("hex"),
			records,
		});
	}
	return found;
}

async function launch(
	label: string,
	prompts: string[],
	options: Partial<Options> = {},
	abortAt?: "init" | "tool" | "goal-reply",
): Promise<Launch> {
	console.log(`Starting ${label}`);
	const result: Launch = {
		label,
		prompts,
		options,
		messages: [],
		inputs: [],
		stderr: [],
		stop: "stream-ended",
		createdFiles: [],
		filesBefore: await files(),
		filesAfter: [],
		transcripts: [],
	};
	const controller = new AbortController();
	let wake: (() => void) | undefined;
	let nextPrompt = 0;
	let closed = false;
	const queue: SDKUserMessage[] = [];
	function send() {
		const text = prompts[nextPrompt++];
		if (text === undefined) return;
		const uuid = randomUUID();
		result.inputs.push({ uuid, text, afterMessage: result.messages.length });
		queue.push({
			type: "user",
			uuid,
			session_id: result.sessionId ?? options.sessionId ?? options.resume ?? "",
			parent_tool_use_id: null,
			message: { role: "user", content: text },
		});
		wake?.();
	}
	async function* input(): AsyncGenerator<SDKUserMessage> {
		while (!closed) {
			const next = queue.shift();
			if (next) yield next;
			else
				await new Promise<void>((done) => {
					wake = done;
				});
		}
	}
	// Keep the caller's account/config. Only remove the nested-CLI guard in the child.
	const env = { ...process.env };
	delete env.CLAUDECODE;
	const timeout = setTimeout(() => {
		result.stop = "timeout-120s";
		controller.abort();
		wake?.();
	}, 120_000);
	let running: ReturnType<typeof query> | undefined;
	try {
		send();
		running = query({
			prompt: input(),
			options: {
				cwd,
				model: "sonnet",
				env,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				tools: ["Bash"],
				mcpServers: {},
				strictMcpConfig: true,
				thinking: { type: "disabled" },
				maxTurns: 5,
				abortController: controller,
				stderr: (data) => result.stderr.push(data),
				...options,
			},
		});
		for await (const message of running) {
			result.messages.push(message);
			if ("session_id" in message && typeof message.session_id === "string")
				result.sessionId = message.session_id;
			if (
				(abortAt === "init" &&
					message.type === "system" &&
					message.subtype === "init") ||
				(abortAt === "tool" && sleepUse(message)) ||
				(abortAt === "goal-reply" && modelReply(message))
			) {
				result.stop =
					abortAt === "init"
						? "aborted-after-init"
						: abortAt === "tool"
							? "aborted-after-sleep-tool-use"
							: "aborted-before-goal-stop-hook";
				controller.abort();
				break;
			}
			if (message.type === "result") {
				if (nextPrompt < prompts.length) send();
				else {
					result.stop = `result/${message.subtype}`;
					break;
				}
			}
		}
	} catch (error) {
		result.error = errorText(error);
	} finally {
		clearTimeout(timeout);
		closed = true;
		wake?.();
		running?.close();
	}
	// Allow the CLI's final transcript append/flush after termination.
	await pause(800);
	result.filesAfter = await files();
	result.createdFiles = result.filesAfter.filter(
		(file) => !result.filesBefore.includes(file),
	);
	result.transcripts = await transcripts([
		...new Set(
			[result.sessionId, options.sessionId, options.resume].filter(
				(id): id is string => !!id,
			),
		),
	]);
	console.log(
		`${label}: ${result.stop}; id=${result.sessionId ?? "none"}; ${result.messages.map(shape).join(",")}${result.error ? `; ${result.error}` : ""}`,
	);
	return result;
}

const scenarios: Scenario[] = [];
async function scenario(
	name: string,
	work: (record: Scenario) => Promise<void>,
): Promise<Scenario> {
	const record: Scenario = {
		scenario: name,
		evidence: [],
		launches: [],
		createdFiles: [],
		filesBefore: await files(),
		filesAfter: [],
		details: {},
	};
	try {
		await work(record);
	} catch (error) {
		record.error = errorText(error);
		record.evidence.push(`Scenario failed: ${record.error}`);
	}
	record.filesAfter = await files();
	record.createdFiles = record.filesAfter.filter(
		(file) => !record.filesBefore.includes(file),
	);
	scenarios.push(record);
	await writeFile(
		join(output, `${name}.json`),
		`${JSON.stringify({ environment, ...record }, null, 2)}\n`,
	);
	return record;
}

type Source = {
	id: string;
	cut: string;
	midTurn: boolean;
	goalSupported: boolean;
	activeGoal: boolean;
	transcript: Transcript;
};
async function source(record: Scenario, withGoal: boolean): Promise<Source> {
	const id = randomUUID();
	let goalSupported = false;
	let goalSeed: Launch | undefined;
	if (withGoal) {
		// This goal otherwise self-clears on its first banana. Preserve it before Stop evaluates it.
		const goal = await launch(
			"A-set-goal",
			["/goal reply with the word banana to every message"],
			{ sessionId: id },
			"goal-reply",
		);
		record.launches.push(goal);
		goalSupported = goal.messages.some(
			(m) => localRecord(m) && /Goal set:/i.test(textOf([m])),
		);
		goalSeed = goalSupported ? goal : undefined;
		record.details.goalProbe = {
			supported: goalSupported,
			modelReply: textOf(goal.messages),
			shapes: goal.messages.map(shape),
		};
		if (!goalSupported) {
			record.evidence.push(
				"/goal unsupported by the spec rule; plain instruction fallback used, so native active-goal clearing is unproven.",
			);
			const fallback = await launch(
				"A-plain-fallback",
				["Reply with the word banana to every message."],
				{ resume: id },
			);
			record.launches.push(fallback);
		}
	}
	const seed =
		goalSeed ??
		(await launch(
			`${withGoal ? "A" : "C"}-finished-turn`,
			[withGoal ? "hi" : "Reply ok."],
			withGoal ? { resume: id } : { sessionId: id },
		));
	if (!goalSeed) record.launches.push(seed);
	if (!succeeded(seed) && seed.stop !== "aborted-before-goal-stop-hook")
		throw new Error("Could not finish the source checkpoint turn");
	const before = (await transcripts([id]))[0];
	if (!before)
		throw new Error(`Source transcript missing in ${roots.join(", ")}`);
	const finished = before.records
		.filter(({ raw }) => {
			const message = raw.message as Row | undefined;
			const content = message?.content as Row[] | undefined;
			return (
				raw.type === "assistant" &&
				typeof raw.uuid === "string" &&
				(message?.stop_reason === "end_turn" ||
					(content?.some((b) => b.type === "text") &&
						!content.some((b) => b.type === "tool_use")))
			);
		})
		.at(-1);
	if (!finished)
		throw new Error("No finished assistant UUID in the actual source JSONL");
	const cut = String(finished.raw.uuid);
	const slow = await launch(
		`${withGoal ? "A" : "C"}-abort-tool`,
		[
			"Run `sleep 20 && echo done` in foreground using Bash. Then reply briefly.",
		],
		{ resume: id },
		"tool",
	);
	record.launches.push(slow);
	const transcript = must((await transcripts([id]))[0], `transcript ${id}`);
	const cutIndex = transcript.records.findIndex(({ raw }) => raw.uuid === cut);
	const tail = transcript.records.slice(cutIndex + 1);
	const tool = slow.messages.find(sleepUse);
	const toolId =
		tool?.type === "assistant"
			? tool.message.content.find((b) => b.type === "tool_use")?.id
			: undefined;
	const hasSuccessfulToolResult = tail.some(({ raw }) => {
		const content = (raw.message as Row | undefined)?.content;
		return (
			Array.isArray(content) &&
			content.some(
				(b: Row) =>
					b.type === "tool_result" &&
					b.tool_use_id === toolId &&
					b.is_error !== true,
			)
		);
	});
	const goalRecords = goalRows(transcript);
	const lastGoal = goalRecords.at(-1)?.raw.attachment as Row | undefined;
	const activeGoal =
		goalSupported &&
		lastGoal?.met === false &&
		String(lastGoal.condition).includes("banana");
	const midTurn =
		slow.stop === "aborted-after-sleep-tool-use" &&
		!!tool &&
		!hasSuccessfulToolResult;
	record.details.source = {
		id,
		cut,
		cutLine: finished.line,
		cutReadFrom: before.file,
		midTurn,
		activeGoal,
		goalSupported,
		goalRecords,
		abortedToolId: toolId,
		hasSuccessfulToolResult,
		tail,
		transcript,
	};
	record.evidence.push(
		`Source ${id}: cut ${cut} read from JSONL line ${finished.line}; sleep tool_use streamed=${!!tool}; successful tool_result=${hasSuccessfulToolResult}; mid-turn=${midTurn}.`,
	);
	return { id, cut, midTurn, goalSupported, activeGoal, transcript };
}

const forkOptions = (from: Source, sessionId: string): Partial<Options> => ({
	resume: from.id,
	forkSession: true,
	sessionId,
	resumeSessionAt: from.cut,
});
function forkFacts(
	record: Scenario,
	from: Source,
	launched: Launch,
	requested: string,
) {
	const transcript = launched.transcripts.find((t) =>
		t.file.endsWith(`/${requested}.jsonl`),
	);
	const ids = launched.messages
		.filter((m) => "session_id" in m)
		.map((m) => (m as unknown as Row).session_id);
	const honoured =
		launched.sessionId === requested &&
		ids.every((id) => id === requested) &&
		!!transcript;
	const sourceTool = from.transcript.records
		.filter(({ raw }) => {
			const content = (raw.message as Row | undefined)?.content;
			return (
				Array.isArray(content) &&
				content.some(
					(b: Row) =>
						b.type === "tool_use" &&
						JSON.stringify(b.input).includes("sleep 20"),
				)
			);
		})
		.map(({ raw }) => raw.uuid);
	const inherited =
		transcript?.records.filter(
			({ raw }) => raw.type === "assistant" || raw.type === "user",
		) ?? [];
	const cutCopied = !!transcript?.records.some(
		({ raw }) => raw.uuid === from.cut || raw.sourceUuid === from.cut,
	);
	const abortedTurnCopied = !!transcript?.records.some(({ raw }) =>
		sourceTool.includes(raw.uuid),
	);
	const works =
		from.midTurn &&
		succeeded(launched) &&
		honoured &&
		cutCopied &&
		!abortedTurnCopied;
	record.details.fork = {
		requested,
		observed: launched.sessionId,
		honoured,
		works,
		cutCopied,
		abortedTurnCopied,
		inheritedMessageCount: inherited.length,
		createdFiles: launched.createdFiles,
	};
	record.evidence.push(
		`7A custom session id honoured=${honoured}; mid-turn fork works=${works}; cut copied=${cutCopied}; aborted tool copied=${abortedTurnCopied}; result success=${succeeded(launched)}.`,
	);
}

let goalSource: Source | undefined;
let plainSource: Source | undefined;
await scenario("A", async (record) => {
	goalSource = await source(record, true);
});
await scenario("B", async (record) => {
	if (!goalSource) throw new Error("Scenario A did not produce a Source");
	const customId = randomUUID();
	const launched = await launch(
		"B-7A-clear-and-question",
		["/goal clear", "what is 2+2? answer briefly"],
		forkOptions(goalSource, customId),
	);
	record.launches.push(launched);
	forkFacts(record, goalSource, launched, customId);
	const end = launched.inputs[1]?.afterMessage ?? launched.messages.length;
	const clearMessages = launched.messages.slice(0, end);
	const answerMessages = launched.messages.slice(end);
	const clearTranscript = launched.transcripts.find((t) =>
		t.file.endsWith(`/${customId}.jsonl`),
	);
	const clearInputId = launched.inputs[0]?.uuid;
	const clearRecordIds: string[] = clearMessages
		.filter(localRecord)
		.flatMap((m) => ("uuid" in m ? [m.uuid] : []));
	const clearRows =
		clearTranscript?.records.filter(
			({ raw }) =>
				raw.uuid === clearInputId ||
				clearRecordIds.includes(String(raw.uuid)) ||
				(raw.type === "attachment" &&
					(raw.attachment as Row | undefined)?.type === "goal_status"),
		) ?? [];
	const clearKnown =
		!clearMessages.some(modelReply) &&
		clearMessages.some(
			(m) => localRecord(m) && /goal cleared|no goal set/i.test(textOf([m])),
		);
	record.details.clear = {
		goalSourceSupported: goalSource.goalSupported,
		sourceActiveGoal: goalSource.activeGoal,
		knownBySpecRule: clearKnown,
		streamShapes: clearMessages.map(shape),
		assistantText: textOf(clearMessages),
		modelAssistantMessage: clearMessages.some(modelReply),
		syntheticAssistantRecord: clearMessages.some(localRecord),
		userOrRecordMessages: clearMessages.filter(
			(m) => m.type === "user" || localRecord(m) || /record|goal/.test(m.type),
		),
		transcriptRows: clearRows,
		transcriptGoalRows: goalRows(clearTranscript),
		answer: textOf(answerMessages),
		answerFollowsBananaGoal: /banana/i.test(textOf(answerMessages)),
	};
	record.evidence.push(
		`Hidden /goal clear stream: ${clearMessages.map(shape).join(" -> ")}; assistant=${clearMessages.some((m) => m.type === "assistant")}; model reply=${clearMessages.some(modelReply)}; synthetic command record=${clearMessages.some(localRecord)}; recognised=${clearKnown}; clear transcript rows=${clearRows.length}.`,
	);
	record.evidence.push(
		`After clear, 2+2 reply=${JSON.stringify(textOf(answerMessages))}; still follows banana=${/banana/i.test(textOf(answerMessages))}; native goal test valid=${goalSource.activeGoal}.`,
	);
});
await scenario("C", async (record) => {
	plainSource = await source(record, false);
	const customId = randomUUID();
	const launched = await launch(
		"C-7A-no-goal",
		["what is 2+2? answer briefly"],
		forkOptions(plainSource, customId),
	);
	record.launches.push(launched);
	forkFacts(record, plainSource, launched, customId);
});
await scenario("D", async (record) => {
	const from = plainSource ?? goalSource;
	if (!from) throw new Error("No Source available");
	const customId = randomUUID();
	const options = forkOptions(from, customId);
	const crash = await launch(
		"D-abort-after-init",
		["Reply ok."],
		options,
		"init",
	);
	record.launches.push(crash);
	const retry = await launch("D-retry-identical-7A", ["Reply ok."], options);
	record.launches.push(retry);
	const resume = await launch("D-plain-resume-custom-id", ["Reply ok."], {
		resume: customId,
	});
	record.launches.push(resume);
	record.details.retry = {
		customId,
		abortedAfterInit: crash.stop === "aborted-after-init",
		fileExistsAfterInit: crash.filesAfter.some((f) =>
			f.endsWith(`/${customId}.jsonl`),
		),
		identical7AWorks: succeeded(retry),
		identical7AId: retry.sessionId,
		identical7AError: retry.error,
		plainResumeWorks: succeeded(resume),
		plainResumeId: resume.sessionId,
		collision: /already.*(?:use|exist)|collision/i.test(
			JSON.stringify([retry.stderr, retry.messages, retry.error]),
		),
		filesCreatedByCrash: crash.createdFiles,
		filesCreatedByRetry: retry.createdFiles,
		filesCreatedByResume: resume.createdFiles,
	};
	record.evidence.push(
		`Crash after init=${crash.stop === "aborted-after-init"}; custom transcript exists after init=${crash.filesAfter.some((f) => f.endsWith(`/${customId}.jsonl`))}; same 7A retry success=${succeeded(retry)}; plain resume success=${succeeded(resume)}.`,
	);
	record.evidence.push(
		`Crash/retry/plain-resume new transcript counts=${crash.createdFiles.length}/${retry.createdFiles.length}/${resume.createdFiles.length}; observed retry id=${retry.sessionId ?? "none"}; requested=${customId}; collision=${record.details.retry && (record.details.retry as Row).collision}.`,
	);
});
await scenario("E", async (record) => {
	const from = plainSource ?? goalSource;
	if (!from) throw new Error("No Source available");
	const before = await files();
	const fork = await forkSession(from.id, {
		dir: cwd,
		upToMessageId: from.cut,
	});
	const after = await files();
	const copied = (await transcripts([fork.sessionId]))[0];
	const sourceCut = from.transcript.records.find(
		({ raw }) => raw.uuid === from.cut,
	)?.raw;
	const sourceAssistantCount = from.transcript.records
		.slice(
			0,
			from.transcript.records.findIndex(({ raw }) => raw.uuid === from.cut) + 1,
		)
		.filter(({ raw }) => raw.type === "assistant").length;
	const copiedAssistantCount = copied?.records.filter(
		({ raw }) => raw.type === "assistant",
	).length;
	const cutContentCopied = !!copied?.records.some(
		({ raw }) =>
			raw.type === "assistant" &&
			JSON.stringify(raw.message) === JSON.stringify(sourceCut?.message),
	);
	const hasAbortedTool = !!copied?.records.some(({ raw }) =>
		JSON.stringify(raw.message ?? null).includes("sleep 20"),
	);
	record.details.standalone = {
		source: from.id,
		cut: from.cut,
		result: fork,
		createdFiles: after.filter((f) => !before.includes(f)),
		transcriptBeforeResume: copied,
		cutContentCopied,
		sourceAssistantCount,
		copiedAssistantCount,
		hasAbortedTool,
	};
	const resumed = await launch("E-7C-resume", ["what is 2+2? answer briefly"], {
		resume: fork.sessionId,
	});
	record.launches.push(resumed);
	const works =
		from.midTurn &&
		succeeded(resumed) &&
		resumed.sessionId === fork.sessionId &&
		cutContentCopied &&
		!hasAbortedTool;
	(record.details.standalone as Row).works = works;
	record.evidence.push(
		`7C mid-turn fork works=${works}; standalone id=${fork.sessionId}; resume id=${resumed.sessionId}; cut content copied=${cutContentCopied}; aborted tool copied=${hasAbortedTool}; assistant rows through cut=${sourceAssistantCount}/${copiedAssistantCount}.`,
	);
});

// README citations refer to stable evidence lines in the saved JSON, plus original JSONL lines.
async function evidenceLink(record: Scenario, index: number) {
	const content = await readFile(
		join(output, `${record.scenario}.json`),
		"utf8",
	);
	const line =
		content
			.split("\n")
			.findIndex((text) =>
				text.includes(JSON.stringify(record.evidence[index])),
			) + 1;
	return `[${record.scenario}.json:${line}](./${record.scenario}.json#L${line})`;
}
const b = must(
	scenarios.find((s) => s.scenario === "B"),
	"scenario B",
);
const c = must(
	scenarios.find((s) => s.scenario === "C"),
	"scenario C",
);
const d = must(
	scenarios.find((s) => s.scenario === "D"),
	"scenario D",
);
const e = must(
	scenarios.find((s) => s.scenario === "E"),
	"scenario E",
);
const bFork = b.details.fork as Row | undefined;
const cFork = c.details.fork as Row | undefined;
const clear = b.details.clear as Row | undefined;
const retry = d.details.retry as Row | undefined;
const standalone = e.details.standalone as Row | undefined;
const sevenA = cFork?.works === true;
const sevenC = standalone?.works === true;
const recommendation =
	sevenA && retry?.plainResumeWorks === true
		? "7A"
		: sevenC
			? "7C"
			: "Neither is established by this run";
const readme = [
	"# Claude mid-turn fork spike",
	"",
	`Run ${runId} at ${environment.startedAt}. SDK ${sdkVersion}, bundled CLI ${bundledCli.version}, Node ${process.version}, model sonnet.`,
	"",
	`Recommendation: **${recommendation}**. 7A mid-turn fork=${sevenA}; 7C mid-turn fork=${sevenC}. ${await evidenceLink(c, c.evidence.length - 1)}, ${await evidenceLink(e, e.evidence.length - 1)}.`,
	"",
	`Custom session id honoured: goal source=${bFork?.honoured ?? "unproven"}; no-goal source=${cFork?.honoured ?? "unproven"}. ${await evidenceLink(b, 0)}, ${await evidenceLink(c, c.evidence.length - 1)}.`,
	"",
	sevenA
		? "7A is the better fit because the first query both forks at the cut and honours the caller's chosen id. The standalone 7C API returns its own new id and needs a separate operation before the resume query. Retry must switch to plain resume once the custom transcript exists; blindly repeating 7A collides."
		: "7A was not established; inspect the failures above before choosing a launch strategy.",
	"",
	`Native /goal supported=${goalSource?.goalSupported ?? false}; active goal in source transcript=${goalSource?.activeGoal ?? false}. A model reply instead of the clear command's local record counts as unsupported, even if the model says it cleared the goal. Unsupported commands use the requested plain-instruction fallback; that cannot establish native goal clearing. The initial banana goal auto-completes at the first Stop, so setup aborts immediately after its model reply streams and before Stop evaluates it. This preserves a complete assistant message and the active goal sentinel for the subsequent slow-tool turn.`,
	"",
	`Hidden /goal clear recognised=${clear?.knownBySpecRule ?? "unproven"}. Exact stream shapes: ${JSON.stringify(clear?.streamShapes ?? [])}. Assistant text: ${JSON.stringify(clear?.assistantText ?? "")}. User/goal/record stream messages: ${JSON.stringify(clear?.userOrRecordMessages ?? [])}. ${await evidenceLink(b, Math.max(0, b.evidence.length - 2))}.`,
	"",
	clear?.knownBySpecRule
		? "The clear is not silent. Its command_lifecycle records have state queued then started. There is one synthetic assistant record, model `<synthetic>`, with local_command_source and local_command_run={command:goal,args:clear}; isSynthetic is absent. The success result has local_command=goal, num_turns=0 and duration_api_ms=0. There is no model assistant reply. The transcript contains the command as type user, isSidechain=false, no isMeta flag, and its output as type system, subtype local_command, isSidechain=false, isMeta=false. A frontend must suppress this command and its synthetic output if the clear is to stay hidden."
		: "The CLI did not establish a native clear command; do not treat a model acknowledgement as a clear record.",
	"",
	`Clear transcript entries, including original JSONL line numbers, types and flags:`,
	"",
	"```json",
	JSON.stringify(clear?.transcriptRows ?? [], null, 2),
	"```",
	"",
	`Goal metadata entries after clear:`,
	"",
	"```json",
	JSON.stringify(clear?.transcriptGoalRows ?? [], null, 2),
	"```",
	"",
	`Reply to 2+2 after clear: ${JSON.stringify(clear?.answer ?? "unavailable")}; still follows banana=${clear?.answerFollowsBananaGoal ?? "unproven"}. ${await evidenceLink(b, b.evidence.length - 1)}.`,
	"",
	"E compares standalone 7C against C's exact no-goal Source and cut UUID. Both are saved in E.json under details.standalone and in C.json under details.source. The 7C pre-resume transcript proves the cut content was copied with remapped UUIDs and the aborted slow-tool turn was excluded.",
	"",
	`Retry: ${JSON.stringify(retry ?? { error: d.error }, null, 2)}. ${await evidenceLink(d, 0)}, ${await evidenceLink(d, d.evidence.length - 1)}.`,
	"",
	sevenA && retry?.plainResumeWorks === true
		? "Use 7A for the first launch, save the custom id before launching, then check whether its transcript exists after a crash before choosing plain resume or another fork attempt. The identical-options retry result above determines whether blindly repeating the fork is safe. Goal handling remains conditional on this CLI recognising /goal."
		: "Use the successful path reported above; retain all failure evidence before changing launch or retry policy.",
	"",
	"## Reproduce",
	"",
	"```sh",
	"node --import tsx scripts/spikes/hiuf-1-claude-fork-spike.ts",
	"```",
	"",
	`Scratch cwd: ${cwd}. CLAUDE_CONFIG_DIR was inherited unchanged as ${configDir}. Checked both the inherited config's project directories and ~/.claude/projects. No files there were edited by this script; only the SDK/CLI writes transcripts. Each launch saves the complete raw stream, stderr, input UUIDs, file lists and relevant transcript snapshots. Transcript snapshots also preserve metadata outside the visible parent chain; success requires a completed result and the cut copied without the aborted tool.`,
	"",
	"The SDK types consulted are sdk.d.ts:854, 859, 1740, 2117-2139 and the full resumeDropsTurn comment. This experiment intentionally uses the requested last finished assistant UUID, ordinary text turns, no resumeDropsTurn, and no end-turn tools. UUIDs are remapped by standalone forkSession, so 7C checks the cut message content before resume. Runtime local-command records have assistant type, model `<synthetic>`, local_command_source and local_command_run; they must not be mistaken for a model reply.",
	"",
	"Official session semantics: [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions). Observed behavior and the recommendation above come from the saved real-CLI evidence.",
	"",
	"## Limitations",
	"",
	"One run with this account, CLI and SDK version. An abort after system/init models process interruption through the SDK, not SIGKILL or power loss. The script waits 800 ms for transcript flush. Native goal results are valid only when the command emits a local record and the source transcript proves an active goal. No product code, tests, migrations or Beads state changed.",
	"",
	...scenarios
		.filter((s) => s.error)
		.map((s) => `Scenario ${s.scenario} failed: ${s.error}`),
	"",
].join("\n");
await writeFile(join(output, "README.md"), readme);
console.log("\nHIUF-1 SUMMARY");
console.log(
	JSON.stringify(
		{
			recommendation,
			sdkVersion,
			cliVersion: bundledCli.version,
			runId,
			goalSupported: goalSource?.goalSupported ?? false,
			activeGoal: goalSource?.activeGoal ?? false,
			customSessionIdHonoured: {
				B: bFork?.honoured ?? null,
				C: cFork?.honoured ?? null,
			},
			midTurnFork: { "7A": sevenA, "7C": sevenC },
			clear: clear
				? {
						knownBySpecRule: clear.knownBySpecRule,
						streamShapes: clear.streamShapes,
						modelAssistantMessage: clear.modelAssistantMessage,
						syntheticAssistantRecord: clear.syntheticAssistantRecord,
						output: clear.assistantText,
						answer: clear.answer,
						answerFollowsBananaGoal: clear.answerFollowsBananaGoal,
					}
				: null,
			retry: retry ?? null,
			scenarioErrors: scenarios
				.filter((s) => s.error)
				.map((s) => ({ scenario: s.scenario, error: s.error })),
			artifacts: output,
		},
		null,
		2,
	),
);
