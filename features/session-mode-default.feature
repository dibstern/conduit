Feature: Drafts use the effective default session mode

Scenario Outline: The context chip starts in the resolved mode
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the next draft resolves to <session_mode> from the project file
  When I open a new draft in the default project
  Then the draft start chip shows "<chip_label>"
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | session_mode | chip_label   | baseline                              | threshold |
  | desktop  | worktree     | New worktree | session-mode-default-worktree-desktop | 98        |
  | phone    | worktree     | New worktree | session-mode-default-worktree-phone   | 98        |
  | desktop  | local        | main         | session-mode-default-local-desktop    | 98        |
  | phone    | local        | main         | session-mode-default-local-phone      | 98        |
