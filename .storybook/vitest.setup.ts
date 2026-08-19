import * as a11yAddonAnnotations from "@storybook/addon-a11y/preview";
import { setProjectAnnotations } from "@storybook/svelte-vite";
import { beforeAll } from "vitest";
import * as projectAnnotations from "./preview";

// The a11y addon's preview annotations are what actually run axe during a story
// test. Without them, `parameters.a11y.test = "error"` in ./preview is inert and
// every story passes the accessibility gate regardless of its violations.
const project = setProjectAnnotations([
	a11yAddonAnnotations,
	projectAnnotations,
]);

beforeAll(project.beforeAll);
