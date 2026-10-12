Feature: OpenCode session rows pick up their generated title

# Failure modes: the row ignores a live shell upsert and keeps the default
# title until a reload; the new title renders mid-gleam or clipped.
Scenario Outline: An untitled OpenCode session row shows its generated title live
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has an OpenCode session titled "<default_title>"
  Then the session list is open
  And the OpenCode session row shows the title "<default_title>"
  When the server renames the OpenCode session to "<generated_title>"
  Then the OpenCode session row shows the title "<generated_title>"
  And the session-list region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | default_title | generated_title              | baseline                    | threshold |
  | desktop  | Untitled      | Fix flaky sidebar scroll test | opencode-auto-title-desktop | 98        |
  | phone    | Untitled      | Fix flaky sidebar scroll test | opencode-auto-title-phone   | 98        |
