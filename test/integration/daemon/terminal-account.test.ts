// Failure modes: a resumed session uses its original account after a switch;
// drafts lose their explicit account; sessionless creates ignore the default;
// account/default edits change a live shell; deleted or unknown ids fail instead
// of falling back; OpenCode picks override the Claude login; zero Claude accounts
// lose the launch environment; folder overrides strip unrelated shell variables.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import {
	ContinueSession,
	CreatePty,
	CreatePtyForSession,
	RemoveInstance,
	SetDefault,
	UpdateInstance,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { PtyInfo } from "../../../src/lib/shared-types.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	ptyEnvelope,
} from "../../helpers/process-harness.js";

async function terminalEnvironment(browser: ProcessBrowser, ptyId: string) {
	const cursor = browser.frames.length;
	let output = "";
	// Split the marker so terminal echo cannot satisfy the assertion.
	await browser.inputPty(
		ptyId,
		'printf \'__ACC%s__%s|%s|%s|%s|%s\\n\' OUNT "$CLAUDE_CONFIG_DIR" "$HOME" "$ANTHROPIC_API_KEY" "$SHELL" "$(pwd -P)"\r',
	);
	await browser.waitFor(() => {
		output = browser.frames
			.slice(cursor)
			.flatMap(({ message }) => {
				const envelope = ptyEnvelope(message);
				return envelope?._tag === "output" && envelope.ptyId === ptyId
					? [envelope.data]
					: [];
			})
			.join("");
		return /__ACCOUNT__([^\r\n]*)\r?\n/.test(output);
	}, cursor);
	const fields = /__ACCOUNT__([^\r\n]*)/.exec(output)?.[1]?.split("|");
	if (!fields || fields.length !== 5)
		throw new Error("Missing shell environment");
	return {
		folder: fields[0],
		home: fields[1],
		apiKey: fields[2],
		shell: fields[3],
		cwd: fields[4],
	};
}

describe("Terminal account login through the daemon and PTY host", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
		scenario = name;
		evidence = {};
		harness = ProcessHarness.create({ managedOpenCode: true });
		const fixture = harness;
		const work = join(fixture.root, "work-login");
		const personal = join(fixture.root, "personal-login");
		mkdirSync(work);
		mkdirSync(personal);
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				port: 0,
				instances: [
					{
						id: "opencode",
						name: "OpenCode",
						driver: "opencode",
						port: 0,
						managed: true,
					},
					{
						id: "work",
						name: "Work",
						driver: "claude",
						configDir: work,
						port: 0,
						managed: false,
					},
					{
						id: "personal",
						name: "Personal",
						driver: "claude",
						configDir: personal,
						port: 0,
						managed: false,
					},
				],
				accountDefaults: { claude: AccountIdSchema.make("work") },
			},
			fixture.configDir,
		);
		const preload = join(fixture.root, "terminal-env.cjs");
		writeFileSync(
			preload,
			"process.env.ANTHROPIC_API_KEY = 'shell-test-key';\n",
		);
		await fixture.restart({
			serviceEnvironment: { NODE_OPTIONS: `--require=${preload}` },
		});
		const browser = await fixture.connect();
		const socket = join(fixture.configDir, "relay.sock");
		async function create(
			accountId?: string,
			sessionId?: string,
		): Promise<PtyInfo> {
			const cursor = browser.frames.length;
			await sendRpcRequest(
				socket,
				sessionId === undefined
					? new CreatePty({
							projectSlug: "process-test",
							originId: browser.originId,
							...(accountId === undefined ? {} : { accountId }),
						})
					: new CreatePtyForSession({
							sessionId,
							originId: browser.originId,
							...(accountId === undefined ? {} : { accountId }),
						}),
			);
			const frame = await browser.waitFor(
				(message) => ptyEnvelope(message)?._tag === "upsert",
				cursor,
			);
			const envelope = ptyEnvelope(frame);
			if (envelope?._tag !== "upsert") throw new Error("Missing terminal");
			return envelope.item;
		}
		return { fixture, browser, socket, create, work, personal };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/g4zp-12-terminal-${scenario}.json`,
				`${JSON.stringify(evidence, null, 2).replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
		}
	});

	it("uses the latest session account and draft pick while sessionless terminals use the default", async () => {
		const { fixture, browser, socket, create, work, personal } =
			await start("selection");
		const sessionId = await browser.createSession("Switched account", "work");
		await sendRpcRequest(
			socket,
			new ContinueSession({
				sessionId,
				instanceId: "personal",
				expectedInstanceId: "work",
			}),
		);
		const row = await browser.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				message["accountId"] === "personal",
		);
		const resumed = await create(String(row["accountId"]), sessionId);
		const resumedEnv = await terminalEnvironment(browser, resumed.id);
		expect(resumedEnv).toEqual({
			folder: personal,
			home: join(fixture.root, "home"),
			apiKey: "shell-test-key",
			shell: "/bin/sh",
			cwd: fixture.projectDir,
		});
		const draftEnv = await terminalEnvironment(
			browser,
			(await create("personal")).id,
		);
		expect(draftEnv).toEqual(resumedEnv);
		const defaultEnv = await terminalEnvironment(browser, (await create()).id);
		expect(defaultEnv).toEqual({ ...resumedEnv, folder: work });
		evidence = {
			resumed: resumedEnv,
			draft: draftEnv,
			sessionless: defaultEnv,
		};
	}, 45_000);

	it("keeps live shells pinned across default and folder edits and resolves stale ids", async () => {
		const { fixture, browser, socket, create, personal } =
			await start("changes");
		const existing = await create("personal");
		const before = await terminalEnvironment(browser, existing.id);
		const existingDefault = await create();
		const defaultBefore = await terminalEnvironment(
			browser,
			existingDefault.id,
		);
		await sendRpcRequest(socket, new SetDefault({ instanceId: "personal" }));
		expect(await terminalEnvironment(browser, existingDefault.id)).toEqual(
			defaultBefore,
		);
		const edited = join(fixture.root, "edited-login");
		mkdirSync(edited);
		await sendRpcRequest(
			socket,
			new UpdateInstance({ instanceId: "personal", configDir: edited }),
		);
		expect(await terminalEnvironment(browser, existing.id)).toEqual(before);
		expect(await terminalEnvironment(browser, existingDefault.id)).toEqual(
			defaultBefore,
		);
		expect(before.folder).toBe(personal);
		const next = await terminalEnvironment(browser, (await create()).id);
		expect(next.folder).toBe(edited);
		await sendRpcRequest(socket, new RemoveInstance({ instanceId: "work" }));
		for (const id of ["work", "unknown-account", "claude", "claude-sdk"]) {
			const env = await terminalEnvironment(browser, (await create(id)).id);
			expect(env).toEqual(next);
			evidence[id] = env;
		}
		evidence["existing"] = before;
		evidence["existingDefault"] = defaultBefore;
		evidence["newDefault"] = next;
	}, 45_000);

	it("uses the Claude default for OpenCode and inherits the launch env with no Claude accounts", async () => {
		const { fixture, browser, socket, create, work } =
			await start("opencode-empty");
		const sessionId = await browser.createSession(
			"OpenCode session",
			"opencode",
			"opencode",
		);
		const openCode = await terminalEnvironment(
			browser,
			(await create("opencode", sessionId)).id,
		);
		expect(openCode.folder).toBe(work);
		await sendRpcRequest(socket, new RemoveInstance({ instanceId: "work" }));
		await sendRpcRequest(
			socket,
			new RemoveInstance({ instanceId: "personal" }),
		);
		const inherited = { ...openCode, folder: join(fixture.root, "claude") };
		for (const id of ["opencode", "work", "unknown-account", undefined]) {
			const env = await terminalEnvironment(browser, (await create(id)).id);
			expect(env).toEqual(inherited);
			evidence[id ?? "sessionless"] = env;
		}
		evidence["openCodeWithDefault"] = openCode;
	}, 45_000);
});
