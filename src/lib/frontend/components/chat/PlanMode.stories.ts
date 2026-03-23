import type { Meta, StoryObj } from "@storybook/svelte-vite";
import PlanMode from "./PlanMode.svelte";

const meta = {
	title: "Chat/PlanMode",
	component: PlanMode,
	tags: ["autodocs"],
} satisfies Meta<typeof PlanMode>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockPlanContent = `## Architecture Overview

The system has three main components:

1. **API Gateway** — handles routing and auth
2. **Worker Service** — processes background jobs
3. **Database Layer** — PostgreSQL with connection pooling

### Implementation Steps

- [ ] Create API routes for \`/users\` and \`/sessions\`
- [ ] Add middleware for authentication tokens
- [ ] Set up worker queue with Redis
- [ ] Implement database migrations

\`\`\`typescript
// Example: API route handler
export async function handleRequest(req: Request): Promise<Response> {
  const session = await getSession(req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  return processRequest(req, session);
}
\`\`\`
`;

export const EnterBanner: Story = {
	args: {
		mode: "enter",
	},
};

export const ExitBanner: Story = {
	args: {
		mode: "exit",
	},
};

export const ContentCard: Story = {
	args: {
		mode: "content",
		content: mockPlanContent,
	},
};

export const Approval: Story = {
	args: {
		mode: "approval",
		onApprove: () => console.log("Plan approved"),
		onReject: () => console.log("Plan rejected"),
	},
};

export const Collapsed: Story = {
	args: {
		mode: "content",
		content: mockPlanContent,
	},
};
