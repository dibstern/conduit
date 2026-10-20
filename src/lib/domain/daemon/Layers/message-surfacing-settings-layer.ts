import { Effect, Layer, Ref } from "effect";
import { DaemonStateTag } from "../Services/daemon-state.js";
import {
	MessageSurfacingSettings,
	makeMessageSurfacingSettings,
} from "../Services/message-surfacing-settings.js";

export const MessageSurfacingSettingsLive = Layer.effect(
	MessageSurfacingSettings,
	Effect.gen(function* () {
		const { configDir } = yield* Ref.get(yield* DaemonStateTag);
		return yield* makeMessageSurfacingSettings(configDir);
	}),
);
