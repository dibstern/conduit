import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDefaultModel,
	getDefaultPermissionMode,
	getDefaultVariant,
} from "../../../src/lib/domain/project-services/Services/session-overrides-state.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";

describe("a daemon project's override-state defaults", () => {
	let project: DaemonProject | undefined;

	afterEach(async () => {
		await project?.stop();
		project = undefined;
	});

	it("seeds persisted default model and variant into Effect override state", async () => {
		project = await createDaemonProject("chat-simple", {
			defaultModel: "claude/claude-sonnet-4-7",
			settings: {
				defaultVariants: { "claude/claude-sonnet-4-7": "thinking" },
				defaultPermissionMode: "auto",
			},
		});

		const seeded = await project.run(
			Effect.gen(function* () {
				return {
					defaultModel: yield* getDefaultModel(),
					defaultVariant: yield* getDefaultVariant(),
					defaultPermissionMode: yield* getDefaultPermissionMode(),
				};
			}),
		);

		expect(seeded).toEqual({
			defaultModel: {
				providerID: "claude",
				modelID: "claude-sonnet-4-7",
			},
			defaultVariant: "thinking",
			defaultPermissionMode: "auto",
		});
	});

	it("starts when OpenCode is unavailable so non-OpenCode providers can load", async () => {
		project = await createDaemonProject("chat-simple", {
			opencodeUrl: "http://127.0.0.1:9",
		});

		// The browser's shell synchronizes without OpenCode.
		const client = await project.connectWsClient();
		await client.waitFor("shell", {
			predicate: (message) => message["_tag"] === "synchronized",
		});
	});
});
