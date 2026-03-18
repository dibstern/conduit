// ─── Sound Notification — Unit Tests ─────────────────────────────────────────
// Tests playDoneSound via Web Audio API mocks.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// We import playDoneSound lazily so each test gets a fresh module state.

// ─── AudioContext mock ───────────────────────────────────────────────────────

function createMockAudioContext() {
	const osc = {
		type: "",
		frequency: { value: 0 },
		connect: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
	};

	const gain = {
		gain: {
			value: 0,
			exponentialRampToValueAtTime: vi.fn(),
		},
		connect: vi.fn(),
	};

	const ctx = {
		state: "running" as string,
		currentTime: 0,
		destination: {},
		resume: vi.fn(),
		createOscillator: vi.fn(() => osc),
		createGain: vi.fn(() => gain),
	};

	return { ctx, osc, gain };
}

describe("playDoneSound", () => {
	let AudioContextMock: ReturnType<typeof vi.fn>;
	let mockCtx: ReturnType<typeof createMockAudioContext>;

	beforeEach(() => {
		mockCtx = createMockAudioContext();
		AudioContextMock = vi.fn(() => mockCtx.ctx);
		vi.stubGlobal("AudioContext", AudioContextMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	test("creates oscillator with 880 Hz sine wave", async () => {
		const { playDoneSound } = await import(
			"../../../src/lib/frontend/utils/sound.js"
		);
		playDoneSound();

		expect(mockCtx.osc.type).toBe("sine");
		expect(mockCtx.osc.frequency.value).toBe(880);
	});

	test("sets gain to 0.1", async () => {
		const { playDoneSound } = await import(
			"../../../src/lib/frontend/utils/sound.js"
		);
		playDoneSound();

		expect(mockCtx.gain.gain.value).toBe(0.1);
	});

	test("ramps to near-zero over 0.3s", async () => {
		const { playDoneSound } = await import(
			"../../../src/lib/frontend/utils/sound.js"
		);
		playDoneSound();

		expect(mockCtx.gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(
			0.001,
			0.3,
		);
	});

	test("stops oscillator at 0.3s", async () => {
		const { playDoneSound } = await import(
			"../../../src/lib/frontend/utils/sound.js"
		);
		playDoneSound();

		expect(mockCtx.osc.stop).toHaveBeenCalledWith(0.3);
	});

	test("connects oscillator → gain → destination", async () => {
		const { playDoneSound } = await import(
			"../../../src/lib/frontend/utils/sound.js"
		);
		playDoneSound();

		expect(mockCtx.osc.connect).toHaveBeenCalledWith(mockCtx.gain);
		expect(mockCtx.gain.connect).toHaveBeenCalledWith(mockCtx.ctx.destination);
	});

	test("resumes suspended AudioContext", async () => {
		mockCtx.ctx.state = "suspended";
		const { playDoneSound } = await import(
			"../../../src/lib/frontend/utils/sound.js"
		);
		playDoneSound();

		expect(mockCtx.ctx.resume).toHaveBeenCalled();
	});

	test("does not throw when AudioContext is unavailable", async () => {
		vi.stubGlobal("AudioContext", undefined);
		// Need fresh module since AudioContext is checked at call time
		const { playDoneSound } = await import(
			"../../../src/lib/frontend/utils/sound.js"
		);

		expect(() => playDoneSound()).not.toThrow();
	});

	test("creates AudioContext lazily on first call", async () => {
		const { playDoneSound } = await import(
			"../../../src/lib/frontend/utils/sound.js"
		);

		expect(AudioContextMock).not.toHaveBeenCalled();
		playDoneSound();
		expect(AudioContextMock).toHaveBeenCalledTimes(1);
	});
});
