Feature: Icons composer matches the final desktop and phone designs

Scenario Outline: phone idle composer is one row with the design's controls
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  Then the composer has 1 row
  And the composer placeholder reads Ask Claude…
  And the placeholder sits on the controls row
  And the composer has no standalone agent selector
  And the model button is 32 pixels tall and reads S5
  And the effort meter is visible
  And send is a 32 pixel square in the off colours
  And the attach button has no border
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                   | threshold |
  | composer-final-idle-phone  | 98        |

Scenario Outline: E1 desktop icons split the footer and drop labels in the narrow tier
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the harness logo is viewed in the <tier> tier
  And the composer uses icons controls
  And the Claude accounts are claude as personal, self as work
  And the composer picker has the Claude catalog
  And approvals are ask
  And the composer checkout is conduit / account-chip as worktree
  When I set effort to high
  Then the composer has 2 rows
  And the composer placeholder reads Ask Claude…
  And the composer has no standalone agent selector
  And the desktop icons footer matches E1 in the <tier> tier
  And the model chip reads Sonnet 5 · 200K with a chevron
  And the icons checkout is a quiet shrinking control before send
  And the composer checkout shows conduit / account-chip with a worktree icon
  And send is a 32 pixel square in the off colours
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu shows conduit and account-chip in full

Examples:
  | tier   | baseline                    | threshold |
  | wide   | composer-final-idle-desktop | 98        |
  | narrow | composer-icons-e1-narrow    | 98        |

Scenario Outline: E2 desktop icons warn about auto approvals and a workspace hint
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the harness logo is viewed in the <tier> tier
  And the composer uses icons controls
  And the Claude accounts are claude as personal, self as work
  And the composer picker has the Claude catalog
  And approvals are auto
  And the composer checkout is conduit / account-chip as worktree
  And the checkout has uncommitted changes, 2 ahead, 0 behind
  And the session has a workspace hint at /workspace/conduit-hint
  When I set effort to high
  Then the composer has 2 rows
  And the icons mode control has hot tint true
  And the composer checkout has a workspace hint icon without inline actions
  And the icons checkout is a quiet shrinking control before send
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu offers Move and Dismiss for /workspace/conduit-hint
  When I choose Dismiss in the composer checkout menu
  Then the checkout Dismiss RPC targets /workspace/conduit-hint

Examples:
  | tier   | baseline                 | threshold |
  | wide   | composer-icons-e2-wide   | 98        |
  | narrow | composer-icons-e2-narrow | 98        |

Scenario Outline: every desktop mode other than the default is hot
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the viewport is a desktop
  And the composer picker has the Claude catalog
  And approvals are <mode>
  Then the approvals chip shows <label>
  And the icons mode control has hot tint <hot>
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | mode        | label       | hot   | baseline                  | threshold |
  | dontAsk     | Never ask   | true  | composer-icons-mode-never | 98        |
  | plan        | Plan        | true  | composer-icons-mode-plan  | 98        |
  | ask         | Ask         | false | composer-icons-mode-ask   | 98        |
  | acceptEdits | Edits       | true  | composer-icons-mode-edits | 98        |
  | auto        | Auto        | true  | composer-icons-mode-auto  | 98        |
  | full        | Full access | true  | composer-icons-mode-full  | 98        |

Scenario Outline: E1 long checkout names truncate before the desktop icons controls
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the harness logo is viewed in the narrow tier
  And the composer picker has the Claude catalog
  And the composer checkout is conduit-worktrees / feature/session-account-chip-redesign as worktree
  Then the model chip reads Sonnet 5 · 200K with a chevron
  And the icons checkout is a quiet shrinking control before send
  And the composer checkout truncates the project before the branch
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu shows conduit-worktrees and feature/session-account-chip-redesign in full

Examples:
  | baseline                      | threshold |
  | composer-icons-e1-long-narrow | 98        |

Scenario Outline: E3 desktop draft keeps the split footer without a checkout
  Given the conduit app is served with the connected mockup
  And I start a new session
  And the harness logo is viewed in the <tier> tier
  And the composer uses icons controls
  And the Claude accounts are claude as personal, self as work
  And the composer picker has the Claude catalog
  When I set effort to high
  Then the desktop icons footer matches E1 in the <tier> tier
  And the icons draft has no checkout and keeps context below the composer
  And the model chip reads Sonnet 5 · 200K with a chevron
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | tier   | baseline                 | threshold |
  | wide   | composer-icons-e3-wide   | 98        |
  | narrow | composer-icons-e3-narrow | 98        |

Scenario Outline: working composer shows a solid stop with a small square
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  Then the composer placeholder reads Ask Claude…
  And stop is a 32 pixel square filled with the text colour around a 10 pixel square
  And send is hidden while the field is empty
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                       | threshold |
  | phone    | composer-final-working-phone   | 98        |
  | desktop  | composer-final-working-desktop | 98        |

Scenario Outline: the picker root carries the agent and switches it
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open the model picker
  Then the picker root sections and rows are harness, model, context, effort, agent
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I view Agent choices in the picker
  Then the picker lists agents Planner, Reviewer
  When I choose agent Reviewer in the picker
  Then the relay is asked to switch the agent to reviewer
  And the picker agent row reads Reviewer

Examples:
  | viewport | baseline                           | threshold |
  | phone    | composer-final-picker-root-phone   | 98        |
  | desktop  | composer-final-picker-root-desktop | 98        |
