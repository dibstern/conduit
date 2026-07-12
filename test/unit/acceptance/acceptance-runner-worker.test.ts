import { describe, expect, test } from "vitest";
import {
	type ExecuteJob,
	handleJob,
	runWorker,
	type WorkerJob,
} from "../../../acceptance/bin/acceptance-runner-worker.js";

describe("acceptance mutation runner worker", () => {
	test("maps runner results to NDJSON protocol responses", async () => {
		const jobs: WorkerJob[] = [
			{
				id: "m-success",
				feature_json: "mutations/m-success/feature.json",
				generated_dir: "generated",
				work_dir: "mutations/m-success",
				timeout: "30s",
			},
			{
				id: "m-failure",
				feature_json: "mutations/m-failure/feature.json",
				generated_dir: "generated",
				work_dir: "mutations/m-failure",
				timeout: "30s",
			},
			{
				id: "m-infrastructure",
				feature_json: "mutations/m-infrastructure/feature.json",
				generated_dir: "generated",
				work_dir: "mutations/m-infrastructure",
				timeout: "30s",
			},
		];
		const executeJob: ExecuteJob = async (job) => {
			switch (job.id) {
				case "m-success":
					return { exitCode: 0, stdout: "passed", stderr: "" };
				case "m-failure":
					return {
						exitCode: 1,
						stdout: "",
						stderr: "assertion failed",
					};
				default:
					return {
						exitCode: 1,
						stdout: "",
						stderr: "INFRASTRUCTURE_ERROR: Chromium failed to launch",
					};
			}
		};
		const protocolLines: string[] = [];
		const diagnostics: string[] = [];

		await runWorker(
			jobs.map((job) => JSON.stringify(job)),
			{
				executeJob,
				writeOutput: (line) => protocolLines.push(line),
				writeDiagnostic: (line) => diagnostics.push(line),
			},
		);

		const responses = protocolLines.map((line) => JSON.parse(line));
		expect(responses).toEqual([
			{
				id: "m-success",
				outcome: "test_success",
				output: "passed",
				error: "",
				duration: expect.any(Number),
			},
			{
				id: "m-failure",
				outcome: "test_failure",
				output: "",
				error: "assertion failed",
				duration: expect.any(Number),
			},
			{
				id: "m-infrastructure",
				outcome: "infrastructure_error",
				output: "",
				error: "INFRASTRUCTURE_ERROR: Chromium failed to launch",
				duration: expect.any(Number),
			},
		]);
		expect(protocolLines).toHaveLength(jobs.length);
		expect(diagnostics).toEqual([
			"m-infrastructure: INFRASTRUCTURE_ERROR: Chromium failed to launch",
		]);
	});

	test("classifies a job timeout as an infrastructure error", async () => {
		const executeJob: ExecuteJob = async (_job, _timeoutMs, signal) =>
			new Promise((resolve) => {
				signal.addEventListener(
					"abort",
					() => resolve({ exitCode: 143, stdout: "", stderr: "" }),
					{ once: true },
				);
			});

		const response = await handleJob(
			{
				id: "m-timeout",
				feature_json: "mutations/m-timeout/feature.json",
				generated_dir: "generated",
				work_dir: "mutations/m-timeout",
				timeout: "1ms",
			},
			{ executeJob },
		);

		expect(response).toMatchObject({
			id: "m-timeout",
			outcome: "infrastructure_error",
			output: "",
			error: "INFRASTRUCTURE_ERROR: Timed out after 1ms",
		});
	});
});
