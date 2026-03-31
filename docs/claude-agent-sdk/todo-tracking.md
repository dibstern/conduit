# Todo Lists

> Source: https://platform.claude.com/docs/en/agent-sdk/todo-tracking
> Extracted: 2026-03-31

Track and display todos using the Claude Agent SDK for organized task management

---

Todo tracking provides a structured way to manage tasks and display progress to users. The SDK includes built-in todo functionality.

## Todo Lifecycle

1. **Created** as `pending` when tasks are identified
2. **Activated** to `in_progress` when work begins
3. **Completed** when the task finishes successfully
4. **Removed** when all tasks in a group are completed

## When Todos Are Used

The SDK automatically creates todos for:
- **Complex multi-step tasks** requiring 3 or more distinct actions
- **User-provided task lists** when multiple items are mentioned
- **Non-trivial operations** that benefit from progress tracking
- **Explicit requests** when users ask for todo organization

## Monitoring Todo Changes

```typescript
for await (const message of query({
  prompt: "Optimize my React app performance and track progress with todos",
  options: { maxTurns: 15 }
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use" && block.name === "TodoWrite") {
        const todos = block.input.todos;
        console.log("Todo Status Update:");
        todos.forEach((todo, index) => {
          const status =
            todo.status === "completed" ? "done" :
            todo.status === "in_progress" ? "working" : "pending";
          console.log(`${index + 1}. [${status}] ${todo.content}`);
        });
      }
    }
  }
}
```

```python
async for message in query(
    prompt="Optimize my React app performance and track progress with todos",
    options={"max_turns": 15},
):
    if isinstance(message, AssistantMessage):
        for block in message.content:
            if isinstance(block, ToolUseBlock) and block.name == "TodoWrite":
                todos = block.input["todos"]
                print("Todo Status Update:")
                for i, todo in enumerate(todos):
                    print(f"{i + 1}. [{todo['status']}] {todo['content']}")
```

## Real-time Progress Display

Build a `TodoTracker` class to accumulate todo state and display progress:
- Count completed vs total tasks
- Show currently active tasks
- Display status icons per task

## Related Documentation

- [Streaming vs Single Mode](./streaming-vs-single-mode.md)
- [Custom Tools](./custom-tools.md)
