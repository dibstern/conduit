import { existsSync } from "node:fs";
import { join } from "node:path";
import { Either } from "effect";
import {
	loadDaemonConfigResult,
	resolveClaudeLaunchConfig,
} from "../lib/daemon/config-persistence.js";
import { makeClaudeSdkEnv } from "../lib/provider/claude/claude-sdk-env.js";
import {
	findExecutable,
	ProjectShellEnvResolver,
} from "../lib/provider/project-shell-env.js";

/** Diagnostics deliberately resolve locally, independent of daemon transports. */
export async function handleDoctor(options: {
	configDir?: string;
	stdout: { write(value: string): void };
}): Promise<void> {
	const loaded = loadDaemonConfigResult(options.configDir);
	if (Either.isLeft(loaded) && loaded.left._tag !== "NotFound")
		throw loaded.left;
	const config = Either.getOrNull(loaded);
	const resolver = new ProjectShellEnvResolver();
	const { stdout } = options;
	stdout.write(
		"Local environment check (fresh resolution; daemon cache is not queried).\n",
	);
	try {
		const projects = config?.projects ?? [];
		if (projects.length === 0) stdout.write("No registered projects.\n");
		for (const project of projects)
			resolver.register(project.path, project.shellEnv);
		for (const project of projects) {
			await resolver.refresh(project.path);
			const snapshot = resolver.snapshot(project.path);
			const launch = resolveClaudeLaunchConfig(
				config,
				undefined,
				resolver.get(project.path),
			);
			const env = makeClaudeSdkEnv({
				baseEnv: resolver.get(project.path),
				...launch,
			});
			stdout.write(`\n${project.slug} (${project.path})\n`);
			stdout.write(`  Env sources: ${snapshot.sources.join(", ")}\n`);
			stdout.write(
				`  Last resolved: ${snapshot.resolvedAt === null ? "never (process fallback)" : new Date(snapshot.resolvedAt).toISOString()}\n`,
			);
			for (const warning of snapshot.warnings)
				stdout.write(`  Warning: ${warning}\n`);
			for (const tool of ["claude", "node", "opencode"])
				stdout.write(
					`  ${tool}: ${findExecutable(tool, env, project.path) ?? "missing"}\n`,
				);
			const claudeHome = launch.configDir.path;
			const credentials = env["CLAUDE_CODE_OAUTH_TOKEN"]
				? "OAuth token present"
				: existsSync(join(claudeHome, ".credentials.json"))
					? "credentials file present"
					: "not found in env/files (OS keychain and cloud credentials not checked)";
			stdout.write(`  Credentials: ${credentials}\n`);
		}
	} finally {
		resolver.close();
	}
}
