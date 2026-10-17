Feature: Run now stops the running turn and sends the selected queued message next

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: Run now starts a plain queued message as a new turn and preserves the remaining order
  Given the viewport is a <viewport>
  And a session already exists on the <harness> harness
  And the composer picker has the <harness> catalog
  When the open session starts working
  And the mock relay queues First queued message
  And the mock relay queues Run this message next with 1 image
  And the mock relay queues Last queued message
  Then pending-input row 1 offers Run now
  And pending-input row 2 offers Run now
  And pending-input row 3 offers Run now
  And the composer region visually matches <baseline> at <threshold> percent
  When I run pending-input row 2 now
  Then the relay is asked to interrupt and run Run this message next
  When the relay interrupts the turn and starts queued message Run this message next
  Then the last user turn is Run this message next without a Steered label
  And the pending-input tray has 2 rows
  And pending-input row 1 reads First queued message
  And pending-input row 2 reads Last queued message

Examples:
  | viewport | harness  | baseline                        | threshold |
  | phone    | Claude   | pending-run-now-claude-phone     | 98        |
  | desktop  | Claude   | pending-run-now-claude-desktop   | 98        |
  | phone    | OpenCode | pending-run-now-opencode-phone   | 98        |
  | desktop  | OpenCode | pending-run-now-opencode-desktop | 98        |
