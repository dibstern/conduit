import { Effect } from "effect";
import type { Account } from "../contracts/account.js";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeSettingsServiceTag,
	OrchestrationEngineTag,
} from "../domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";

export const MAX_PROJECT_TITLE_LENGTH = 100;

// OpenCode's command list carries no built-in flag: its defaults and the user's
// config commands both arrive as source "command".
const OPENCODE_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
	"init",
	"review",
]);

export const normalizeProjectTitle = (title: string): string =>
	title.trim().slice(0, MAX_PROJECT_TITLE_LENGTH);

const listSessionCommands = (
	activeSessionId: string | undefined,
	tolerateDiscoveryFailure = true,
	draftInstanceId?: string,
) =>
	Effect.gen(function* () {
		const engine = yield* OrchestrationEngineTag;
		const directory = yield* AccountDirectory;
		const boundId = activeSessionId
			? yield* engine.getProviderForSessionEffect(activeSessionId)
			: undefined;
		// A draft has no session yet; the account it picked owns its catalogue.
		const accountId = boundId ?? draftInstanceId;
		const account = yield* directory.resolve(
			accountId === undefined
				? { _tag: "DriverDefault", driver: "opencode" }
				: { _tag: "Id", id: accountId },
		);
		const listDiscoveredCommands = (selected: Account) =>
			Effect.gen(function* () {
				const workspaceRoot = activeSessionId
					? yield* (yield* SessionWorkspaceTag).get(activeSessionId)
					: (yield* ConfigTag).projectDir;
				return yield* engine
					.dispatchEffect({
						type: "discover",
						providerId: selected.id,
						account: selected,
						...(activeSessionId ? { sessionId: activeSessionId } : {}),
						workspaceRoot,
					})
					.pipe(
						Effect.map((capabilities) => capabilities.commands),
						Effect.catch((error) =>
							tolerateDiscoveryFailure
								? Effect.gen(function* () {
										(yield* LoggerTag).warn(
											`Failed to discover ${selected.name} commands: ${error instanceof Error ? error.message : error}`,
										);
										return [];
									})
								: Effect.fail(error),
						),
					);
			});
		if (PROVIDER_DRIVERS[account.driver].catalogSource === "discovery")
			return yield* listDiscoveredCommands(account);
		const result = yield* Effect.result(
			(yield* OpenCodeSettingsServiceTag).listCommands({
				startIfStopped: !tolerateDiscoveryFailure,
			}),
		);
		if (result._tag === "Success") return result.success;
		if (boundId !== undefined) return yield* Effect.fail(result.failure);
		(yield* LoggerTag).warn(
			`Failed to discover OpenCode commands; falling back to Claude commands: ${result.failure instanceof Error ? result.failure.message : result.failure}`,
		);
		return yield* listDiscoveredCommands(
			yield* directory.resolve({ _tag: "DriverDefault", driver: "claude" }),
		);
	});

export const getCommandsForSession = (
	activeSessionId: string | undefined,
	draftInstanceId?: string,
) =>
	listSessionCommands(activeSessionId, true, draftInstanceId).pipe(
		Effect.map((commands) =>
			commands.map((command) => ({
				name: command.name,
				...(command.description ? { description: command.description } : {}),
				...("args" in command && command.args ? { args: command.args } : {}),
				...(command.source === "builtin" ||
				(command.source === "command" &&
					OPENCODE_BUILTIN_COMMANDS.has(command.name))
					? { builtin: true }
					: {}),
			})),
		),
	);

export const getSkillNamesForSession = (sessionId: string) =>
	listSessionCommands(sessionId, false).pipe(
		Effect.map(
			(commands) =>
				new Set(
					commands
						.filter(
							(command) =>
								!command.name.startsWith("anthropic-skills:") &&
								(command.source === "user-skill" ||
									command.source === "project-skill" ||
									command.source === "plugin-skill" ||
									command.source === "skill"),
						)
						.map((command) => command.name),
				),
		),
	);
