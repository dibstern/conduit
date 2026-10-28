import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import { createLogger } from "../logger.js";
import type { DiscoveredSkill } from "./types.js";

const log = createLogger("opencode-discovery");

export async function discoverOpenCodeCatalog(
	client: OpenCodeAPI,
	directory?: string,
) {
	const [commands, listed] = await Promise.all([
		client.app.commands(),
		client.app.skills(directory).catch((error: unknown) => {
			log.warn(
				"Failed to discover OpenCode skills; keeping command-only skills",
				error,
			);
			return [];
		}),
	]);
	// @opencode-ai/sdk 1.19.1, dist/v2/gen/types.gen.d.ts:
	// AppSkillsResponses (/skill) reports location; Command has only source: "skill".
	// Keep the provider's file location and its containing directory, never infer by name.
	const skills = await Promise.all(
		listed.map(async (skill): Promise<DiscoveredSkill> => {
			const path = skill.location;
			const file = path !== undefined && isAbsolute(path);
			const canonicalPath = file
				? await realpath(path).catch(() => path)
				: undefined;
			const offset = file && directory ? relative(directory, path) : undefined;
			return {
				name: skill.name,
				...(skill.description !== undefined
					? { description: skill.description }
					: {}),
				source:
					!file ||
					(offset !== undefined &&
						offset !== ".." &&
						!offset.startsWith(`..${sep}`) &&
						!isAbsolute(offset))
						? "project-skill"
						: "user-skill",
				location:
					canonicalPath !== undefined
						? {
								_tag: "File",
								path: canonicalPath,
								root: dirname(canonicalPath),
							}
						: { _tag: "Provider" },
			};
		}),
	);
	for (const command of commands) {
		if (
			command.source !== "skill" ||
			skills.some((skill) => skill.name === command.name)
		)
			continue;
		skills.push({
			name: command.name,
			...(command.description !== undefined
				? { description: command.description }
				: {}),
			source: "project-skill",
			location: { _tag: "Provider" },
		});
	}
	return { commands, skills };
}
