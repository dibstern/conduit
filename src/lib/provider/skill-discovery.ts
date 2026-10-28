import { createHash } from "node:crypto";
import type { CommandInfo, DiscoveredSkill } from "./types.js";

/** References identify discovery records; they are never decoded into paths. */
export const skillRefFor = (skill: DiscoveredSkill): string =>
	createHash("sha256")
		.update(JSON.stringify([skill.name, skill.source, skill.location]))
		.digest("hex");

export const skillCommand = (skill: DiscoveredSkill): CommandInfo => ({
	name: skill.name,
	source: skill.source,
	...(skill.description === undefined
		? {}
		: { description: skill.description }),
	skillRef: skillRefFor(skill),
});
