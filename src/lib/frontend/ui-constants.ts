// ─── Frontend UI Timing Constants ───────────────────────────────────────────

/** How long to show copy-success feedback icon (ms). */
export const COPY_FEEDBACK_MS = 1500;

/** How long browser notifications stay visible before auto-dismiss (ms). */
export const NOTIFICATION_DISMISS_MS = 5000;

/** How long status messages display before clearing (ms). */
export const STATUS_MESSAGE_MS = 3000;

/** Fade duration for verb cycling in connect overlay (ms). */
export const VERB_FADE_MS = 300;

/** Interval between verb cycles in connect overlay (ms). */
export const VERB_CYCLE_MS = 2000;

/** Fade-out animation duration when connection is established (ms). */
export const CONNECT_FADEOUT_MS = 600;

/** Safety timeout waiting for server response to add-project (ms). */
export const ADD_PROJECT_TIMEOUT_MS = 15_000;

/** Timeout waiting for full tool content to load (ms). */
export const TOOL_CONTENT_LOAD_TIMEOUT_MS = 10_000;

/** Timeout for HTTPS verification probe during setup (ms). */
export const HTTPS_VERIFY_TIMEOUT_MS = 3000;

/** Delay before auto-advancing to next setup step (ms). */
export const SETUP_STEP_TRANSITION_MS = 1200;
