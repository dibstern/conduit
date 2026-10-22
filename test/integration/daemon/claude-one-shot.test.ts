// Failure modes: the process fake never receives the call, one-shot options
// drift, or a schema-invalid reply succeeds instead of returning a Failure.
import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

it("runs the shared call against the process harness fake SDK and rejects schema-invalid output", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "conduit-one-shot-"));
	const receivedFile = join(scratch, "received.jsonl");
	const moduleRoot = process.env["CONDUIT_TEST_DIST"] ?? ".";
	const serviceUrl = pathToFileURL(
		resolve(
			moduleRoot,
			`src/lib/domain/daemon/Services/claude-one-shot.${moduleRoot === "." ? "ts" : "js"}`,
		),
	).href;
	const fakeUrl = new URL(
		"../../helpers/fake-claude-process-sdk.ts",
		import.meta.url,
	).href;
	try {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
			import { Effect, Schema } from "effect";
			import { makeClaudeOneShot } from ${JSON.stringify(serviceUrl)};
			import { claudeSdk } from ${JSON.stringify(fakeUrl)};
			const calls = [];
			const client = makeClaudeOneShot({
				configDir: { _tag: "Configured", path: ${JSON.stringify(scratch)} },
				cwd: ${JSON.stringify(scratch)},
				systemPrompt: "Return only the requested answer.",
				queryFactory: (params) => {
					const { model, maxTurns, persistSession, tools, allowedTools, thinking, settings, systemPrompt, cwd, env } = params.options;
					calls.push({ prompt: params.prompt, model, maxTurns, persistSession, tools, allowedTools, thinking, settings, systemPrompt, cwd, configDir: env.CLAUDE_CONFIG_DIR });
					return claudeSdk.titleQuery(params);
				},
			});
			const text = await Effect.runPromise(client.ask("plain reply", Schema.String, "opus"));
			const invalid = await Effect.runPromise(Effect.result(client.ask("structured reply", Schema.Struct({ answer: Schema.Number }), "sonnet")));
			console.log(JSON.stringify({ calls, text, invalid }));
			`,
			],
			{
				cwd: fileURLToPath(new URL("../../../", import.meta.url)),
				env: { ...process.env, CONDUIT_TEST_CLAUDE_TITLES_FILE: receivedFile },
				timeout: 15_000,
				maxBuffer: 64 * 1024,
			},
		);
		const proof: Record<string, unknown> = JSON.parse(stdout);
		const received = readFileSync(receivedFile, "utf8")
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/ahu8-15-claude-one-shot.json",
			JSON.stringify({ ...proof, received }, null, 2),
		);
		expect(proof["text"]).toBe("Process harness session");
		expect(proof["invalid"]).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "ClaudeOneShotFailure", reason: "schema" },
		});
		expect(received).toEqual([
			{ prompt: "plain reply", cwd: scratch },
			{ prompt: "structured reply", cwd: scratch },
		]);
		expect(proof["calls"]).toEqual(
			["opus", "sonnet"].map((model, index) => ({
				prompt: index === 0 ? "plain reply" : "structured reply",
				model,
				cwd: scratch,
				configDir: scratch,
				maxTurns: 1,
				persistSession: false,
				tools: [],
				allowedTools: [],
				thinking: { type: "disabled" },
				systemPrompt: "Return only the requested answer.",
				settings: {
					disableAllHooks: true,
					outputStyle: "default",
					claudeMdExcludes: ["**"],
				},
			})),
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("persists the existing session title through the daemon process harness", async () => {
	const dist = process.env["CONDUIT_TEST_DIST"];
	const harness = await ProcessHarness.start(
		dist === undefined ? {} : { dist },
	);
	try {
		const browser = await harness.connect();
		const sessionId = await browser.createSession();
		const message = "Fix the OAuth callback loop.";
		await browser.send(sessionId, message);
		const db = new Database(harness.daemonStorePath(), { readonly: true });
		try {
			const readTitle = db.prepare<[string], { title: string }>(
				"SELECT title FROM sessions WHERE id = ?",
			);
			await vi.waitFor(
				() => {
					expect(readTitle.get(sessionId)?.title).toBe(
						"Process harness session",
					);
				},
				{ timeout: 10_000 },
			);
			expect(harness.claudeTitles()).toEqual([
				{
					prompt: expect.stringContaining(`<message>\n${message}\n</message>`),
					cwd: expect.stringContaining(
						join(harness.configDir, "text-generation", "run-"),
					),
				},
			]);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ahu8-15-claude-one-shot-daemon.json",
				JSON.stringify(
					{
						sessionId,
						title: readTitle.get(sessionId)?.title,
						requests: harness.claudeTitles(),
					},
					null,
					2,
				),
			);
		} finally {
			db.close();
		}
	} finally {
		await harness.dispose();
	}
});
