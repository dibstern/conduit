import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { setDefaultModelForRelay } from "../../../src/lib/handlers/model.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
	type RecordedWebSocketCall,
} from "../../helpers/mock-factories.js";

const snapshotPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../snapshots/handlers/models.json",
);

const readSnapshots = (): Record<string, RecordedWebSocketCall[]> =>
	JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<
		string,
		RecordedWebSocketCall[]
	>;

interface ModelApiOverrides {
	readonly providerList?: OpenCodeAPI["provider"]["list"];
	readonly sessionGet?: OpenCodeAPI["session"]["get"];
	readonly configUpdate?: OpenCodeAPI["config"]["update"];
}

const makeModelApi = (overrides: ModelApiOverrides): OpenCodeAPI => {
	const api = makeMockOpenCodeAPI();
	if (overrides.providerList) {
		vi.spyOn(api.provider, "list").mockImplementation(overrides.providerList);
	}
	if (overrides.sessionGet) {
		vi.spyOn(api.session, "get").mockImplementation(overrides.sessionGet);
	}
	if (overrides.configUpdate) {
		vi.spyOn(api.config, "update").mockImplementation(overrides.configUpdate);
	}
	return api;
};

describe("model handler wire snapshots", () => {
	it("keeps the OpenCode default-model envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeModelApi({
			configUpdate: vi.fn(async () => undefined),
			providerList: vi.fn(async () => ({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [
							{
								id: "gpt-4",
								name: "GPT-4",
								variants: { standard: {}, fast: {} },
							},
						],
					},
				],
			})),
		});

		await Effect.runPromise(
			setDefaultModelForRelay({
				clientId: "client-1",
				model: "gpt-4",
				provider: "openai",
			}).pipe(
				Effect.provide(
					makeTestHandlerLayer({
						api,
						wsHandler,
						config: makeMockConfig({
							configDir: mkdtempSync(join(tmpdir(), "conduit-default-model-")),
							projectDir: mkdtempSync(join(tmpdir(), "conduit-project-")),
						}),
					}),
				),
			),
		);

		expect(calls).toEqual(readSnapshots()["default_model_opencode_success"]);
	});
});
