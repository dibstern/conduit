// Fails a project in which no test actually executed. Playwright reports "passed"
// when every test skipped (e.g. the daemon suite without a reachable OpenCode),
// and a gate that checks only the exit code reads that as green. Registered in
// the configs the local gates run (scripts/test-all.sh); conduit-test-g49a.

import type {
	FullConfig,
	FullResult,
	Reporter,
	TestCase,
	TestResult,
} from "@playwright/test/reporter";

export default class RequireTestsReporter implements Reporter {
	private executed = new Map<string, number>();

	onBegin(config: FullConfig): void {
		this.executed.clear();
		// FullConfig includes unselected projects; the suite tree omits empty ones.
		// Playwright accepts repeated flags and variadic --project name name.
		const names: string[] = [];
		let collectingProjects = false;
		for (const arg of process.argv.slice(2)) {
			if (arg === "--") break;
			if (arg.startsWith("-")) {
				collectingProjects = arg === "--project";
				if (arg.startsWith("--project=")) names.push(arg.slice(10));
			} else if (collectingProjects) {
				names.push(arg);
			}
		}
		const selectors = names.map(
			(name) =>
				new RegExp(
					`^${name.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*")}$`,
					"i",
				),
		);
		for (const project of config.projects) {
			if (
				selectors.length === 0 ||
				selectors.some((pattern) => pattern.test(project.name))
			) {
				this.executed.set(project.name, 0);
			}
		}
	}

	onTestEnd(test: TestCase, result: TestResult): void {
		const project = test.parent.project()?.name ?? "";
		if (result.status !== "skipped") {
			this.executed.set(project, (this.executed.get(project) ?? 0) + 1);
		}
	}

	async onEnd(
		result: FullResult,
	): Promise<{ status: FullResult["status"] } | undefined> {
		// `--list` executes nothing by design.
		if (process.argv.includes("--list")) return undefined;
		if (result.status !== "passed") return undefined;
		const empty = [...this.executed]
			.filter(([, count]) => count === 0)
			.map(([name]) => name || "(unnamed)");
		if (this.executed.size > 0 && empty.length === 0) return undefined;
		console.error(
			`\nNo test executed (all skipped or none selected) in projects: ${empty.join(", ") || "(none)"}; failing the run.`,
		);
		return { status: "failed" };
	}
}
