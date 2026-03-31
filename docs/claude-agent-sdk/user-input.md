# Handle approvals and user input

> Source: https://platform.claude.com/docs/en/agent-sdk/user-input
> Extracted: 2026-03-31

Surface Claude's approval requests and clarifying questions to users, then return their decisions to the SDK.

---

While working on a task, Claude sometimes needs to check in with users. It might need permission before deleting files, or need to ask which database to use for a new project. Your application needs to surface these requests to users so Claude can continue with their input.

Claude requests user input in two situations: when it needs **permission to use a tool** (like deleting files or running commands), and when it has **clarifying questions** (via the `AskUserQuestion` tool). Both trigger your `canUseTool` callback, which pauses execution until you return a response.

## Detect when Claude needs input

Pass a `canUseTool` callback in your query options:

```python
async def handle_tool_request(tool_name, input_data, context):
    # Prompt user and return allow or deny
    ...

options = ClaudeAgentOptions(can_use_tool=handle_tool_request)
```

```typescript
async function handleToolRequest(toolName, input, options) {
  // Prompt user and return allow or deny
}

const options = { canUseTool: handleToolRequest };
```

## Handle tool approval requests

The callback receives three arguments:

| Argument | Description |
|----------|-------------|
| `toolName` | Tool Claude wants to use (e.g., `"Bash"`, `"Write"`, `"Edit"`) |
| `input` | Parameters Claude is passing to the tool |
| `options`/`context` | Additional context including optional `suggestions` and cancellation signal |

### Respond to tool requests

| Response | Python | TypeScript |
|----------|--------|------------|
| **Allow** | `PermissionResultAllow(updated_input=...)` | `{ behavior: "allow", updatedInput }` |
| **Deny** | `PermissionResultDeny(message=...)` | `{ behavior: "deny", message }` |

Beyond allowing or denying:
- **Approve**: let the tool execute as requested
- **Approve with changes**: modify the input before execution
- **Reject**: block the tool and tell Claude why
- **Suggest alternative**: block but guide Claude toward what the user wants
- **Redirect entirely**: use streaming input to send new instructions

## Handle clarifying questions

When Claude needs more direction, it calls the `AskUserQuestion` tool. Check if `tool_name == "AskUserQuestion"` to handle it differently.

### Question format

Each question has:
- `question`: The full question text
- `header`: Short label (max 12 characters)
- `options`: Array of 2-4 choices, each with `label` and `description`
- `multiSelect`: If `true`, users can select multiple options

### Response format

Return an `answers` object mapping each question's `question` field to the selected option's `label`:

```json
{
  "questions": [...],
  "answers": {
    "How should I format the output?": "Summary",
    "Which sections should I include?": "Introduction, Conclusion"
  }
}
```

### Option previews (TypeScript)

`toolConfig.askUserQuestion.previewFormat` adds a `preview` field to each option. Formats: `"markdown"` or `"html"`.

## Limitations

- **Subagents**: `AskUserQuestion` is not currently available in subagents
- **Question limits**: 1-4 questions with 2-4 options each

## Related resources

- [Configure permissions](./permissions.md)
- [Control execution with hooks](./hooks.md)
