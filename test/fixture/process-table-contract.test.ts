import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";

const exec = promisify(execFile);
const reports: Record<string, unknown> = {};
afterAll(() => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		`test-results/process-table-contract.${process.platform}-${process.arch}.json`,
		JSON.stringify(reports, null, 2),
	);
});

for (const disabled of [false, true]) {
	it(`process-table contract on real processes${disabled ? " with FFI disabled" : ""}`, async () => {
		const mode = disabled ? "fallback" : "production";
		try {
			const { stdout, stderr } = await exec(
				process.execPath,
				[
					...(disabled ? ["--no-experimental-ffi"] : []),
					"--import",
					"tsx",
					"test/fixtures/process-table-contract.ts",
				],
				{ timeout: 30_000 },
			);
			expect(stderr).toContain("ExperimentalWarning: unrelated warning");
			expect(stderr).toContain("Warning: FFI is an experimental feature");
			expect(stderr).not.toContain("ExperimentalWarning: FFI");
			reports[mode] = { outcome: "passed", report: JSON.parse(stdout) };
		} catch (error) {
			reports[mode] = {
				outcome: "failed",
				error:
					error instanceof Error ? error.message.slice(-3000) : String(error),
				stdout:
					error instanceof Error && "stdout" in error
						? error.stdout
						: undefined,
				stderr:
					error instanceof Error && "stderr" in error
						? String(error.stderr).slice(-4000)
						: undefined,
				exitCode:
					error instanceof Error && "code" in error ? error.code : undefined,
			};
			throw error;
		}
	});
}

it("importing the process table does not load FFI or warn", async () => {
	const { stderr } = await exec(process.execPath, [
		"--import",
		"tsx",
		"--input-type=module",
		"-e",
		`
		const original = process.getBuiltinModule;
		process.getBuiltinModule = (id) => {
			if (id === 'node:ffi') throw new Error('FFI loaded at import');
			return original(id);
		};
		await import('./src/lib/provider/runner/process-table.ts');
	`,
	]);
	expect(stderr).not.toMatch(/FFI|ExperimentalWarning/);
});

it.skipIf(process.platform !== "darwin")(
	"a failed native self-check falls back once and keeps unrelated warnings",
	async () => {
		const { stdout, stderr } = await exec(process.execPath, [
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		const original = process.getBuiltinModule;
		process.getBuiltinModule = (id) => id === 'node:ffi' ? {
			dlopen: () => {
				process.emitWarning('unrelated during load', 'ExperimentalWarning');
				throw new Error('self-check: incompatible API');
			},
		} : original(id);
		const { makeProductionProcessTable } = await import('./src/lib/provider/runner/process-table.ts');
		const warnings = [];
		const table = makeProductionProcessTable((message) => warnings.push(message));
		for (let i = 0; i < 3; i++) {
			if (table.identify([process.pid]).get(process.pid)?.state !== 'running') throw new Error('fallback failed');
		}
		console.log(JSON.stringify(warnings));
	`,
		]);
		const warnings: string[] = JSON.parse(stdout);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("incompatible API");
		expect(stderr).toContain("ExperimentalWarning: unrelated during load");
	},
);

it("CLI help never loads FFI or emits its warning", async () => {
	const { stdout, stderr } = await exec(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
		const original = process.getBuiltinModule;
		process.getBuiltinModule = (id) => {
			if (id === 'node:ffi') throw new Error('CLI loaded FFI');
			return original(id);
		};
		process.argv = [process.execPath, 'conduit', '--help'];
		await import('./src/bin/cli.ts');
	`,
		],
		{ timeout: 20_000 },
	);
	expect(stdout).toContain("conduit");
	expect(stderr).not.toMatch(/FFI|ExperimentalWarning/);
});
