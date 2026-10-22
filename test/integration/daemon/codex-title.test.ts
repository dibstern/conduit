// Failure modes: Claude-only title routing, leaking named-account credentials,
// starting configured MCP servers, running inside the project, ignoring the
// selected title model, parsing progress instead of the final answer,
// and writing anything but the dated fallback after a failed request.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
} from "../../helpers/codex-app-server.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const MODEL = "gpt-6.1-sol";
interface TitleInvocation {
	argv: string[];
	cwd: string;
	home: string;
	environmentKeys: string[];
	stdin: string;
}

describe("Codex session titles through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let artifactRoot = "";
	let reportPath = "";
	let invocationPath = "";
	let tracePath = "";

	async function start(name: string, fail = false) {
		artifactRoot = resolve(`test-results/codex-title/${name}`);
		mkdirSync(artifactRoot, { recursive: true });
		reportPath = join(artifactRoot, "trace-report.jsonl");
		invocationPath = join(artifactRoot, "title-invocations.jsonl");
		writeFileSync(reportPath, "");
		writeFileSync(invocationPath, "");
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			logLevel: "warn",
		});
		const fixture = harness;
		const bin = join(fixture.root, "title-bin");
		mkdirSync(bin);
		const executable = join(bin, "codex");
		writeFileSync(
			executable,
			String.raw`#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
(async () => {
  const argv = process.argv.slice(2);
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  const record = { argv, cwd: process.cwd(), home: process.env.CODEX_HOME, environmentKeys: Object.keys(process.env), stdin };
  fs.appendFileSync(${JSON.stringify(invocationPath)}, JSON.stringify(record) + "\n");
  if (argv[0] === "mcp" && argv[1] === "list") {
    const config = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    const names = [...config.matchAll(/\[mcp_servers\.([\w-]+)\]/g)].map(match => ({ name: match[1] }));
    console.log(JSON.stringify(names));
    return;
  }
  if (argv[0] !== "exec") throw new Error("Unexpected Codex command " + argv.join(" "));
  if (${fail}) { process.stderr.write("fixture title failure\n"); process.exitCode = 1; return; }
  console.log(JSON.stringify({ title: "Wrong progress title" }));
  const outputIndex = argv.indexOf("--output-last-message");
  if (outputIndex === -1) throw new Error("Missing final-message output");
  fs.writeFileSync(argv[outputIndex + 1], "Fix OAuth Callback Loop\n");
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
		);
		chmodSync(executable, 0o755);
		vi.stubEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
		tracePath = join(fixture.root, "codex-replay.jsonl");
		writeFileSync(
			tracePath,
			`${signedInCodexDiscoveryTrace()
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
				CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
				OPENAI_API_KEY: "fixture-openai",
				CODEX_API_KEY: "fixture-codex",
				CODEX_ACCESS_TOKEN: "fixture-access-token",
			},
		});
		const browser = await fixture.connect();
		const home = join(fixture.root, "named-title-home");
		mkdirSync(home);
		writeFileSync(
			join(home, "config.toml"),
			`model = "account-default-model"\n[mcp_servers.docs]\ncommand = "/bin/false"\n[mcp_servers.git-helper]\ncommand = "/bin/false"\n`,
		);
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Title account",
			driver: "codex",
			configDir: home,
		});
		if (!added.addedInstanceId) throw new Error("Missing named account");
		expect(await codexModels(browser, added.addedInstanceId)).toContainEqual(
			expect.objectContaining({ id: MODEL }),
		);
		const id = await browser.createSession(
			undefined,
			added.addedInstanceId,
			"codex",
			{ modelId: MODEL, contextWindow: "", permissionMode: "ask" },
		);
		const selection = {
			account: { _tag: "Id", id: added.addedInstanceId },
			providerId: "codex",
			modelId: MODEL,
			effort: "low",
		} as const;
		expect(
			await fixture.requestRpc({
				_tag: "SetTitleGeneration",
				projectSlug: "process-test",
				selection,
			}),
		).toMatchObject({ selection, status: "ok" });
		writeFileSync(
			tracePath,
			`${fixtureRows("basic")
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		await browser.send(id, "Please fix the OAuth callback loop.", TIMEOUT);
		return { fixture, id, home };
	}

	function title(fixture: ProcessHarness, id: string) {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			return db
				.prepare<[string], { title: string }>(
					"SELECT title FROM sessions WHERE id = ?",
				)
				.get(id)?.title;
		} finally {
			db.close();
		}
	}

	afterEach(async () => {
		if (!harness) {
			vi.unstubAllEnvs();
			return;
		}
		const fixture = harness;
		try {
			await fixture.dispose();
			const reports = rows<AppServerTraceReport>(reportPath);
			expect(reports.length).toBeGreaterThan(0);
			for (const report of reports) {
				expect(report.consumed).toBe(report.total);
				expect(report.mismatches).toEqual([]);
				expect(report.unconsumed).toEqual([]);
			}
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it(
		"titles a Codex session using its named home with every MCP server disabled",
		async () => {
			const { fixture, id, home } = await start("named-account");
			await vi.waitFor(
				() => expect(title(fixture, id)).toBe("Fix OAuth Callback Loop"),
				{ timeout: TIMEOUT, interval: 100 },
			);
			const invocations = rows<TitleInvocation>(invocationPath);
			const discovery = invocations.find(({ argv }) => argv[0] === "mcp");
			expect(discovery?.argv).toEqual(["mcp", "list", "--json"]);
			const exec = invocations.find(({ argv }) => argv[0] === "exec");
			expect(exec).toBeDefined();
			if (!exec) throw new Error("Missing title exec");
			expect(exec.argv).toEqual(
				expect.arrayContaining([
					"--ephemeral",
					"-s",
					"read-only",
					"--skip-git-repo-check",
					"-c",
					"mcp_servers.docs.enabled=false",
					"mcp_servers.git-helper.enabled=false",
					'model_reasoning_effort="low"',
				]),
			);
			// The title selection, not the session or account default, picks the model.
			expect(exec.argv[exec.argv.indexOf("--model") + 1]).toBe(MODEL);
			expect(exec.argv.at(-1)).toBe("-");
			expect(exec.stdin).toContain(
				"<message>\nPlease fix the OAuth callback loop.\n</message>",
			);
			expect(discovery?.stdin).toBe("");
			for (const invocation of [discovery, exec]) {
				expect(invocation?.home).toBe(home);
				// An empty scratch folder keeps project instructions out of the call.
				expect(
					relative(
						join(fixture.configDir, "text-generation"),
						invocation?.cwd ?? "",
					),
				).toMatch(/^codex-[^/]+\/work$/);
				for (const key of [
					"OPENAI_API_KEY",
					"CODEX_API_KEY",
					"CODEX_ACCESS_TOKEN",
				])
					expect(invocation?.environmentKeys).not.toContain(key);
			}
			expect(existsSync(join(fixture.root, "claude-titles.jsonl"))).toBe(false);
			expect(existsSync(exec.cwd)).toBe(false);
		},
		TIMEOUT * 3,
	);

	it(
		"falls back to a dated title when Codex title generation fails",
		async () => {
			const { fixture, id } = await start("failure", true);
			await vi.waitFor(
				() => expect(fixture.logTail).toContain("fixture title failure"),
				{ timeout: TIMEOUT, interval: 100 },
			);
			expect(
				rows<TitleInvocation>(invocationPath).filter(
					({ argv }) => argv[0] === "exec",
				),
			).toHaveLength(1);
			// A failed request leaves the dated fallback, never generated text.
			expect(title(fixture, id)).toMatch(
				/^Session \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
			);
		},
		TIMEOUT * 3,
	);
});
