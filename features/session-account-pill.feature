Feature: A Claude session's account pill switches the session, not the project

Scenario Outline: a Claude session's bar names the account it runs on
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal
  And the project is bound to claude
  Then the session bar account pill reads work2claude
  And the session bar account pill shows claude with a blue dot
  And the session bar account pill is <height>px tall with <size>px monospace text
  And the session bar account pill sits right after the segment control
  And the session bar shows no instance badge

Examples:
  | viewport | height | size |
  | desktop  | 22     | 10   |
  | phone    | 20     | 9    |

Scenario Outline: switching from the pill moves the session and leaves the project's binding alone
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal, team as team-max
  And the project is bound to claude
  And the transcript ends with the unanswered message Now run the provider tests and fix anything that fails
  And the quota check reads claude 40% used, self 23% used, team limited until 2026-01-01T14:30:00Z
  And the handoff carries 47 of 112 messages with the first
  When I open the account pill in the session bar
  Then the account picker opens <placement>
  And the account picker row for work2claude reads 60% left and cannot be picked
  And the account picker row for personal reads 77% left and can be picked
  And the account picker row for team-max reads limited · 14:30 and cannot be picked
  And the account picker pre-selects personal
  When I pick personal in the account picker
  Then the PreviewContinuation RPC previews the current session on self
  And the handoff dialog asks Continue on personal?
  And the swap card hands work2claude at 60% left to personal at 77% left
  When I press Switch and continue
  Then the ContinueSession RPC switches the current session from claude to self
  And the SetProjectInstance RPC was not sent
  And the handoff dialog is closed
  When the session resumes on self from claude by user and replies All provider tests pass now.
  Then the session bar account pill reads personal
  And the session bar account pill shows self with a teal dot

Examples:
  | viewport | placement         |
  | desktop  | below the pill    |
  | phone    | as a bottom sheet |

Scenario: a Claude session with one account has no pill and no project badge
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude
  And the project is bound to claude
  Then the session bar shows no account pill
  And the session bar shows no instance badge

Scenario: a Claude session shows no project badge while its provider is still loading
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the session's provider lookup is held
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal
  And the project is bound to claude
  Then the session bar shows no account pill
  And the session bar shows no instance badge
  When the session's provider lookup answers
  Then the session bar account pill reads work2claude
  And the session bar shows no instance badge

Scenario: an OpenCode session keeps the project's instance badge
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the OpenCode harness
  And the Claude accounts are claude as work2claude, self as personal
  And the project is bound to claude
  Then the session bar shows no account pill
  And the session bar shows the instance badge reading work2claude
  When I pick personal from the instance badge
  Then the SetProjectInstance RPC binds the project to self

Scenario Outline: session bar with the account pill matches frame D
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal
  And the project is bound to claude
  Then the session bar account pill reads work2claude
  And the session-bar region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                    | threshold |
  | desktop  | session-account-pill-desktop | 98        |
  | phone    | session-account-pill-phone   | 98        |

Scenario Outline: account picker opened from the pill matches frame D
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the Claude accounts are claude as work2claude, self as personal, team as team-max
  And the project is bound to claude
  And the quota check reads claude 40% used, self 23% used, team limited until 2026-01-01T14:30:00Z
  When I open the account pill in the session bar
  Then the account picker pre-selects personal
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                            | threshold |
  | desktop  | session-account-pill-picker-desktop | 98        |
  | phone    | session-account-pill-picker-phone   | 98        |
