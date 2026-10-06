import { Layer } from "effect";
import { vi } from "vitest";
import { SessionManagerServiceTag } from "../../src/lib/domain/relay/Services/session-manager-service.js";
import type { OpenCodeAPI } from "../../src/lib/instance/opencode-api.js";
import type { Logger } from "../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import {
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
} from "./mock-factories.js";

type OpenCodeAPIOverrides = {
	readonly [K in
		| "session"
		| "permission"
		| "question"
		| "config"
		| "provider"
		| "pty"
		| "file"
		| "find"
		| "app"
		| "event"]?: Partial<OpenCodeAPI[K]>;
};

export function makeHandlerOpenCodeAPI(
	overrides: OpenCodeAPIOverrides = {},
): OpenCodeAPI {
	const api = makeMockOpenCodeAPI();
	if (overrides.session) Object.assign(api.session, overrides.session);
	if (overrides.permission) Object.assign(api.permission, overrides.permission);
	if (overrides.question) Object.assign(api.question, overrides.question);
	if (overrides.config) Object.assign(api.config, overrides.config);
	if (overrides.provider) Object.assign(api.provider, overrides.provider);
	if (overrides.pty) Object.assign(api.pty, overrides.pty);
	if (overrides.file) Object.assign(api.file, overrides.file);
	if (overrides.find) Object.assign(api.find, overrides.find);
	if (overrides.app) Object.assign(api.app, overrides.app);
	if (overrides.event) Object.assign(api.event, overrides.event);
	return api;
}

export function makeHandlerLogger(): Logger {
	const logger: Logger = {
		debug: vi.fn(),
		verbose: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn(() => logger),
	};
	return logger;
}

/** What a session model-settings write needs: a store to commit its event to. */
export function makeSessionSettingsLayer() {
	return Layer.merge(
		makePersistenceEffectLayer(":memory:"),
		Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
	);
}
