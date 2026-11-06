/**
 * The daemon-owned project behind "No project" sessions (ADR-0011). Generated slugs are
 * `[a-z0-9-]`, so no user project can take this one. Never listed, saved or removed;
 * each session runs in its own `<configDir>/scratch/<session id>` folder.
 */
export const SCRATCH_PROJECT_SLUG = "_scratch";
export const SCRATCH_PROJECT_TITLE = "No project";
export const SCRATCH_FOLDER = "scratch";
