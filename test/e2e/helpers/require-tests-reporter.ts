// ─── Require Tests Reporter ──────────────────────────────────────────────────
// Fails a run in which no test actually executed. Playwright reports "passed"
// when every test skipped (e.g. the daemon suite without a reachable OpenCode),
// and a gate that checks only the exit code reads that as green. Registered in
// the configs the local gates run (scripts/test-all.sh); conduit-test-g49a.

import type {
	FullResult,
	Reporter,
	TestCase,
	TestResult,
} from "@playwright/test/reporter";

export default class RequireTestsReporter implements Reporter {
	private executed = 0;

	onTestEnd(_test: TestCase, result: TestResult): void {
		if (result.status !== "skipped") this.executed++;
	}

	async onEnd(
		result: FullResult,
	): Promise<{ status: FullResult["status"] } | undefined> {
		// `--list` executes nothing by design.
		if (process.argv.includes("--list")) return undefined;
		if (result.status !== "passed" || this.executed > 0) return undefined;
		console.error(
			"\nNo test executed (all skipped or none selected); failing the run.",
		);
		return { status: "failed" };
	}
}
