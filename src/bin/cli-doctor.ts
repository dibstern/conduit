import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
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
	const config = loadDaemonConfig(options.configDir);
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
			const configDir = project.instanceId
				? (resolveClaudeInstanceConfigDir(config, project.instanceId) ??
					config?.claudeConfigDir)
				: config?.claudeConfigDir;
			const env = makeClaudeSdkEnv({
				baseEnv: resolver.get(project.path),
				...(configDir && { configDir }),
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
			const claudeHome =
				env["CLAUDE_CONFIG_DIR"] ?? join(env["HOME"] ?? homedir(), ".claude");
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
