Feature: Launching rows show each background task's real state, time and usage

Scenario Outline: A turn's launching rows show each task's state, time and usage
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the session's live background tasks are the dev server, the flaky-test agent and that agent's nested shell
  And the transcript has a turn that launched a task in every state
  Then the turn head shows "3 running"
  And 2 launching steps breathe on the activity strip
  When I open the turn's steps
  Then the "Map the session store" step is an ordinary foreground step
  And the "Run the dev server" launching row is running and reads "1m 35s"
  And the "Fix the flaky test" launching row is running and reads "42s · 12k tokens · 3 tools"
  And the "Fix the flaky test" launching row is doing "Running pnpm test" with +1 task
  And the "Fix the flaky test" launching row announces "running, Running pnpm test, 42s, 1 nested task running"
  And the "Review the router" launching row is done and reads "done · 18s · 24k tokens · 6 tools"
  And the "Review the router" launching row shows no step and no nested tasks
  And the "Run the e2e suite" launching row is failed and reads "failed · 4m 12s"
  And the "Profile the build" launching row is stopped and reads "stopped · 1m 1s · 8.2k tokens · 2 tools"
  And the "Watch the logs" launching row is no longer running and reads "no longer running"
  And the "Watch the logs" launching row announces "no longer running"
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline              | threshold |
  | desktop  | launching-rows-desktop | 98        |
  | phone    | launching-rows-phone   | 98        |

Scenario: The turn head stops counting once its tasks finish
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the session's live background tasks are the dev server, the flaky-test agent and that agent's nested shell
  And the transcript has a turn that launched a task in every state
  Then the turn head shows "3 running"
  When the session's live background tasks all finish
  Then the turn head shows "2 running"
  And 2 launching steps breathe on the activity strip
  When I open the turn's steps
  Then the "Run the dev server" launching row is running and reads "1m 35s"
  And the "Fix the flaky test" launching row is running and reads "42s · 12k tokens · 3 tools"
  When the launching row clock advances by 3 seconds
  Then the turn head shows no running pill
  And no launching steps breathe on the activity strip
  And the "Run the dev server" launching row is no longer running and reads "no longer running"
  And the "Fix the flaky test" launching row is no longer running and reads "no longer running · 12k tokens · 3 tools"
