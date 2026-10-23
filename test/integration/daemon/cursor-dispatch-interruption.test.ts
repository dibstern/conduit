// Failure modes: a same-tick bound interrupt overtakes native session admission,
// or a stale input's delayed interrupt cancels a replacement native turn.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Result } from "effect";
import { beforeEach, expect } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeCursorSessionRunner } from "../../../src/lib/provider/cursor/cursor-runner-payload.js";
import { createTraceCursorSdkPort } from "../../../src/lib/provider/cursor/sdk-trace-player.js";
import { makeProcessSessionRunner } from "../../../src/lib/provider/runner/process-session-runner.js";
import { connectRunner } from "../../../src/lib/provider/runner/runner-connection.js";
import { cursorCredentialFixture } from "../../helpers/cursor-account-resources-fixture.js";

beforeEach(() => mkdirSync("test-results/82tn9-5", { recursive: true }));

it.live(
	"honors a bound interrupt in the same scheduler tick as command dispatch",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), "cursor-dispatch-interrupt-"));
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(root, { recursive: true, force: true })),
				);
				const trace = join(root, "cursor.jsonl");
				writeFileSync(
					trace,
					readFileSync(
						resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl"),
						"utf8",
					).replaceAll('"status":"finished"', '"status":"cancelled"'),
				);
				const terminal = yield* Deferred.make<string>();
				const events: string[] = [];
				let cancellations = 0;
				const port = createTraceCursorSdkPort(trace);
				const create = port.createAgent;
				port.createAgent = async (...args) => {
					const agent = await create(...args);
					const send = agent.send.bind(agent);
					agent.send = async (...args) => {
						const run = await send(...args);
						const cancel = run.cancel.bind(run);
						run.cancel = async () => {
							cancellations++;
							await cancel();
						};
						return run;
					};
					return agent;
				};
				const runner = yield* makeCursorSessionRunner(
					{
						workspaceRoot: root,
						daemonConfigDir: root,
						port,
						credential: () =>
							cursorCredentialFixture("[REDACTED:environment]", "environment"),
						environment: () => ({
							NODE_ENV: "test",
							CURSOR_API_KEY: "[REDACTED:environment]",
						}),
					},
					(output) =>
						Effect.gen(function* () {
							if (output.type === "event") {
								events.push(output.event.type);
								if (
									["turn.interrupted", "turn.completed", "turn.error"].includes(
										output.event.type,
									)
								)
									yield* Deferred.succeed(terminal, output.event.type);
							}
							return {};
						}),
				);
				const sending = yield* runner
					.executeEffect({
						type: "send-turn",
						sinkId: "input",
						aborted: false,
						input: {
							sessionId: "session",
							inputId: "input",
							runId: "run",
							prompt: "Say hello",
							history: [],
							providerState: {},
							workspaceRoot: root,
							extraFolders: [],
							configDir: configuredClaudeConfigDir(root),
							folderSource: "account",
							model: { providerId: "cursor", modelId: "composer-2.5" },
						},
					})
					.pipe(Effect.forkChild({ startImmediately: true }));
				yield* runner.executeEffect({
					type: "interrupt",
					sessionId: "session",
					turnIds: ["input"],
				});
				const outcome = yield* Effect.result(
					Deferred.await(terminal).pipe(Effect.timeout("1 second")),
				);
				writeFileSync(
					"test-results/82tn9-5/lifetime-dispatch-race.json",
					JSON.stringify(
						{
							cancellations,
							events,
							outcome: Result.isSuccess(outcome) ? outcome.success : "timeout",
						},
						null,
						2,
					),
				);
				expect(outcome).toMatchObject({
					_tag: "Success",
					success: "turn.interrupted",
				});
				expect(cancellations).toBe(1);
				yield* Fiber.join(sending);
			}),
		),
);

it.live.each(["opening", "preparation"] as const)(
	"returns a settlement failure when account %s is invalidated before native dispatch",
	(phase) =>
		Effect.scoped(
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), "cursor-admission-interrupt-"));
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(root, { recursive: true, force: true })),
				);
				const runner = yield* makeProcessSessionRunner(
					{
						daemonConfigDir: root,
						projectRootForSession: () => Effect.succeed(root),
					},
					() => Effect.succeed({}),
					{
						driverKind: "cursor",
						withAccountScope: (_accountId, work) =>
							phase === "opening" ? Effect.interrupt : work,
						coldUpgrade: true,
						connect: connectRunner,
						settingsDeferredCode: "cursor_settings_deferred",
						warmCommand: (sessionId, _state, snapshot) => ({
							type: "pre-warm",
							sessionId,
							input: snapshot.input,
						}),
						snapshotCommandSettings: () => ({}),
						loginChange: () => "None",
						recoverCommands: () => Effect.succeed([]),
					},
				);
				let prepared = false;
				const outcome = yield* Effect.exit(
					runner.withTurnEffect(
						{
							sessionId: "session",
							inputId: "input",
							runId: "run",
							prompt: "Say hello",
							history: [],
							providerState: {},
							workspaceRoot: root,
							extraFolders: [],
							configDir: configuredClaudeConfigDir(root),
							folderSource: "account",
							model: { providerId: "cursor", modelId: "composer-2.5" },
							account: {
								id: AccountIdSchema.make("cursor-a"),
								driver: "cursor",
								name: "A",
								env: {},
								usageEligible: false,
							},
						},
						"input",
						Effect.sync(() => {
							prepared = true;
						}).pipe(Effect.andThen(Effect.interrupt)),
					),
				);
				const failure = Exit.isFailure(outcome)
					? Cause.findError(outcome.cause)
					: undefined;
				writeFileSync(
					`test-results/82tn9-5/lifetime-${phase}.json`,
					JSON.stringify({ prepared, outcome, failure }, null, 2),
				);
				expect(failure).toMatchObject({
					_tag: "Success",
					success: {
						operation: phase === "opening" ? "retain account" : "prepare turn",
						message: "Cursor account was invalidated",
					},
				});
				expect(prepared).toBe(phase === "preparation");
			}),
		),
);
