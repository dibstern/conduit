import type { Meta, StoryObj } from "@storybook/svelte-vite";
import DashboardPage from "./DashboardPage.svelte";
import type { DashboardProject } from "./dashboard-types.js";

const meta = {
	title: "Pages/DashboardPage",
	component: DashboardPage,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
	},
} satisfies Meta<typeof DashboardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Mock data ──────────────────────────────────────────────────────────────

const mockProjects: DashboardProject[] = [
	{
		slug: "conduit",
		path: "/Users/dev/projects/conduit",
		title: "Conduit",
		status: "ready",
		sessions: 5,
		clients: 2,
		isProcessing: true,
	},
	{
		slug: "my-api",
		path: "/Users/dev/projects/my-api",
		title: "My API Server",
		status: "ready",
		sessions: 12,
		clients: 0,
		isProcessing: false,
	},
	{
		slug: "frontend-app",
		path: "/Users/dev/projects/frontend-app",
		title: "",
		status: "registering",
		sessions: 0,
		clients: 0,
		isProcessing: false,
	},
	{
		slug: "broken-service",
		path: "/Users/dev/projects/broken-service",
		title: "Broken Service",
		status: "error",
		error: "Connection refused: ECONNREFUSED 127.0.0.1:4096",
		sessions: 0,
		clients: 0,
		isProcessing: false,
	},
];

// ─── Stories ────────────────────────────────────────────────────────────────

/** Multiple project cards with various states. */
export const WithProjects: Story = {
	args: {
		initialProjects: mockProjects,
		initialVersion: "0.4.2",
	},
};

/** No projects registered — empty state message. */
export const Empty: Story = {
	args: {
		initialProjects: [],
		initialVersion: "0.4.2",
	},
};

/** A single project card. */
export const SingleProject: Story = {
	args: {
		initialProjects: [
			{
				slug: "solo-project",
				path: "/Users/dev/solo-project",
				title: "Solo Project",
				status: "ready",
				sessions: 1,
				clients: 1,
				isProcessing: false,
			},
		],
		initialVersion: "0.4.2",
	},
};

/** Many projects — exercises scroll behavior and bottom fade gradient. */
export const ManyProjects: Story = {
	args: {
		initialProjects: Array.from({ length: 15 }, (_, i) => ({
			slug: `project-${i + 1}`,
			path: `/Users/dev/projects/project-${i + 1}`,
			title: `Project ${i + 1}`,
			status: (["ready", "ready", "registering", "error"] as const)[i % 4],
			error: i % 4 === 3 ? "Connection refused" : undefined,
			sessions: Math.floor(Math.random() * 20),
			clients: Math.floor(Math.random() * 5),
			isProcessing: i % 3 === 0,
		})),
		initialVersion: "0.4.2",
	},
};
