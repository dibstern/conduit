import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export type WorkerJob = {
	id: string;
	feature_json: string;
	generated_dir: string;
	work_dir: string;
	timeout?: string;
};

export type WorkerOutcome =
	| "test_success"
	| "test_failure"
	| "infrastructure_error";

export type WorkerResponse = {
	id: string;
	outcome: WorkerOutcome;
	output: string;
	error: string;
	duration: number;
};

export type ExecuteJobResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

export type ExecuteJob = (
	job: WorkerJob,
	timeoutMs: number,
	signal: AbortSignal,
) => Promise<ExecuteJobResult>;

type HandleJobOptions = {
	executeJob?: ExecuteJob;
};

type RunWorkerOptions = HandleJobOptions & {
	writeOutput: (line: string) => void;
	writeDiagnostic: (line: string) => void;
};

const TIMEOUT_CLEANUP_GRACE_MS = 1000;

class JobTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Timed out after ${timeoutMs}ms`);
	}
}

function parseTimeout(timeout: string): number {
	const match = timeout.match(/^(\d+)(ms|s|m)$/);
	if (!match) {
		throw new Error(`Unsupported timeout: ${timeout}`);
	}
	const value = Number(match[1]);
	const unit = match[2];
	if (unit === "ms") return value;
	if (unit === "s") return value * 1000;
	return value * 60 * 1000;
}

function jobTimeout(job: WorkerJob): number {
	return parseTimeout(
		job.timeout ?? process.env["ACCEPTANCE_MUTATION_JOB_TIMEOUT"] ?? "30s",
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function timeoutResult(timeoutMs: number): ExecuteJobResult {
	return {
		exitCode: 124,
		stdout: "",
		stderr: `INFRASTRUCTURE_ERROR: Timed out after ${timeoutMs}ms`,
	};
}

async function executeWithTimeout(
	executeJob: ExecuteJob,
	job: WorkerJob,
	timeoutMs: number,
): Promise<ExecuteJobResult> {
	const controller = new AbortController();
	const execution = executeJob(job, timeoutMs, controller.signal);
	let timeoutId: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new JobTimeoutError(timeoutMs)),
			timeoutMs,
		);
	});

	try {
		return await Promise.race([execution, timeout]);
	} catch (error) {
		if (!(error instanceof JobTimeoutError)) {
			throw error;
		}

		controller.abort(error);
		await Promise.race([
			execution.catch(() => undefined),
			delay(TIMEOUT_CLEANUP_GRACE_MS),
		]);
		return timeoutResult(timeoutMs);
	} finally {
		clearTimeout(timeoutId);
	}
}

function terminateProcessGroup(
	pid: number | undefined,
	signal: NodeJS.Signals,
): void {
	if (!pid || process.platform === "win32") return;
	try {
		process.kill(-pid, signal);
	} catch {
		// The process may have already exited between timeout and cleanup.
	}
}

async function defaultExecuteJob(
	job: WorkerJob,
	_timeoutMs: number,
	signal: AbortSignal,
): Promise<ExecuteJobResult> {
	const generatedEntrypoint = join(
		job.generated_dir,
		"composer-send-button.acceptance.ts",
	);

	return new Promise((resolve, reject) => {
		const child = spawn(
			"pnpm",
			["exec", "tsx", generatedEntrypoint, job.feature_json],
			{
				detached: process.platform !== "win32",
				env: {
					...process.env,
					ACCEPTANCE_IR_PATH: job.feature_json,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		let forceKillTimer: NodeJS.Timeout | undefined;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		const abort = () => {
			terminateProcessGroup(child.pid, "SIGTERM");
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => {
				terminateProcessGroup(child.pid, "SIGKILL");
				child.kill("SIGKILL");
			}, 500);
			forceKillTimer.unref();
		};
		const cleanup = () => {
			signal.removeEventListener("abort", abort);
			clearTimeout(forceKillTimer);
		};

		signal.addEventListener("abort", abort, { once: true });
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("close", (exitCode, exitSignal) => {
			cleanup();
			if (exitCode === null) {
				const reason = exitSignal
					? `runner exited due to signal ${exitSignal}`
					: "runner exited without an exit code";
				stderr = `${stderr}${stderr ? "\n" : ""}INFRASTRUCTURE_ERROR: ${reason}`;
			}
			resolve({
				exitCode: exitCode ?? 1,
				stdout,
				stderr,
			});
		});
	});
}

function workerOutcome(result: ExecuteJobResult): WorkerOutcome {
	if (result.exitCode === 0) return "test_success";
	if (result.stderr.includes("INFRASTRUCTURE_ERROR:")) {
		return "infrastructure_error";
	}
	return "test_failure";
}

export async function handleJob(
	job: WorkerJob,
	options: HandleJobOptions = {},
): Promise<WorkerResponse> {
	const start = process.hrtime.bigint();
	const executeJob = options.executeJob ?? defaultExecuteJob;

	try {
		const timeoutMs = jobTimeout(job);
		const result = await executeWithTimeout(executeJob, job, timeoutMs);
		return {
			id: job.id,
			outcome: workerOutcome(result),
			output: result.stdout,
			error: result.stderr,
			duration: Number(process.hrtime.bigint() - start),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			id: job.id,
			outcome: "infrastructure_error",
			output: "",
			error: message,
			duration: Number(process.hrtime.bigint() - start),
		};
	}
}

export async function runWorker(
	lines: Iterable<string> | AsyncIterable<string>,
	options: RunWorkerOptions,
): Promise<void> {
	for await (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		let response: WorkerResponse;
		try {
			const job = JSON.parse(line) as WorkerJob;
			response = await handleJob(job, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			response = {
				id: "unknown",
				outcome: "infrastructure_error",
				output: "",
				error: message,
				duration: 0,
			};
		}

		if (response.outcome === "infrastructure_error") {
			options.writeDiagnostic(`${response.id}: ${response.error}`);
		}
		options.writeOutput(JSON.stringify(response));
	}
}

async function cli(): Promise<void> {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	await runWorker(lines, {
		writeOutput: (line) => process.stdout.write(`${line}\n`),
		writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
	});
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1]
	? fileURLToPath(pathToFileURL(process.argv[1]))
	: "";

if (currentFile === invokedFile) {
	cli().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
}
