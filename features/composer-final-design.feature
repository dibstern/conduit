Feature: Icons composer matches the final desktop and phone designs

Scenario Outline: E1 phone closed composer is one row with the design's controls
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer uses icons controls
  And the Claude accounts are claude as personal, self as work
  And the composer picker has the Claude catalog
  And approvals are ask
  And the composer checkout is conduit / account-chip as worktree
  Then the composer has 1 row
  And the composer placeholder reads Ask Claude…
  And the placeholder sits on the controls row
  And the composer has no standalone agent selector
  And the model button is 26 pixels tall and reads S5
  And the phone icons line matches E1 with the default shield hidden
  And the phone composer amber dot is hidden
  And send is a 30 pixel square in the off colours
  And the attach button has no border
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                   | threshold |
  | composer-final-idle-phone  | 98        |

Scenario Outline: the phone ⋯ sheet
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer uses icons controls
  And the Claude accounts are claude as personal, self as work
  And the composer picker has the Claude catalog
  And approvals are ask
  And the composer checkout is conduit / account-chip as worktree
  And the mock relay reports context 42 percent
  When I set effort to high
  And I open the phone composer sheet
  Then the phone composer sheet matches E1
  And the screen region visually matches <baseline> at <threshold> percent
  When I close the phone composer sheet
  Then the phone icons line matches E1 with the default shield hidden

Examples:
  | baseline                    | threshold |
  | composer-icons-e1-sheet     | 98        |

Scenario Outline: every phone sheet picker row opens its target
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer uses icons controls
  And the Claude accounts are claude as personal, self as work
  And the composer picker has the Claude catalog
  When I tap the phone composer <row> row
  Then the phone composer sheet gives way to the picker
  And the icons control opens the picker at <section>
  When I close the model picker
  Then the shared composer picker is closed
  And the phone composer more button is focused

Examples:
  | row     | section |
  | Harness | Harness |
  | Model   | Model   |
  | Effort  | Effort  |

Scenario: the phone model control opens Model directly
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I tap the icons model control
  Then the icons control opens the picker at Model

Scenario: the phone sheet Mode row opens the existing ranked mode menu
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I tap the phone composer Mode row
  Then the phone composer sheet keeps the Mode menu above it
  And the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full
  When I set approvals to auto
  Then the approvals menu is closed
  And the phone composer Mode row reads Auto
  When I close the phone composer sheet
  Then the phone hot shield is visible for Auto

Scenario: the phone sheet Checkout row opens checkout details
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the composer checkout is conduit / account-chip as worktree
  When I tap the phone composer Checkout row
  Then the phone composer sheet keeps the Checkout menu above it
  And the composer checkout menu shows conduit and account-chip in full

Scenario Outline: E2 phone shows a hot shield and amber dot for a workspace hint
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer uses icons controls
  And the Claude accounts are claude as personal, self as work
  And the composer picker has the Claude catalog
  And approvals are auto
  And the composer checkout is conduit / account-chip as worktree
  And the checkout has uncommitted changes, 2 ahead, 0 behind
  And the session has a workspace hint at /workspace/conduit-chip
  When I set effort to high
  Then the phone hot shield is visible for Auto
  And the phone composer amber dot is visible
  And the composer region visually matches <closed> at <threshold> percent
  When I tap the approvals shield
  Then the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full
  When I set approvals to auto
  And I open the phone composer sheet
  Then the phone composer warning row reports Claude is working in ../conduit-chip and offers Move and Dismiss
  And the screen region visually matches <open> at <threshold> percent
  When I choose <action> in the phone composer warning row
  Then the checkout <action> RPC targets /workspace/conduit-chip
  And the phone composer warning row is absent
  And the phone composer amber dot is hidden

Examples:
  | action  | closed                  | open                       | threshold |
  | Move    | composer-icons-e2-phone | composer-icons-e2-sheet     | 98        |
  | Dismiss | composer-icons-e2-phone | composer-icons-e2-sheet     | 98        |

Scenario: a phone workspace mismatch also keeps the amber dot and warning actions
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the composer checkout is conduit / account-chip as worktree
  And the session has a workspace mismatch at /workspace/conduit-chip
  Then the phone composer amber dot is visible
  When I open the phone composer sheet
  Then the phone composer warning row reports ../conduit-chip and offers Move and Dismiss
  When I choose Move in the phone composer warning row
  Then the checkout Move RPC targets /workspace/conduit
  And the phone composer warning row is absent
  And the phone composer amber dot is hidden

Scenario: dismissing a phone workspace mismatch acknowledges its warning locally
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the composer checkout is conduit / account-chip as worktree
  And the session has a workspace mismatch at /workspace/conduit-chip
  When I open the phone composer sheet
  And I choose Dismiss in the phone composer warning row
  Then the phone composer warning row is absent
  And the phone composer amber dot is hidden
  And the workspace mismatch stays recorded at /workspace/conduit-chip without a Dismiss RPC
  When I close the phone composer sheet
  And I open the phone composer sheet
  Then the phone composer warning row is absent
  When I tap the phone composer Checkout row
  Then the composer checkout menu reports /workspace/conduit-chip and offers Retry move

Scenario: a phone hint and mismatch at the same path have separate Dismiss actions
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the composer checkout is conduit / account-chip as worktree
  And the session has a workspace hint at /workspace/conduit-chip
  And the session has a workspace mismatch at /workspace/conduit-chip
  When I open the phone composer sheet
  And I choose Dismiss in the phone composer warning row
  Then the phone composer warning row reports ../conduit-chip and offers Move and Dismiss
  And the phone composer amber dot is visible
  And the workspace mismatch stays recorded at /workspace/conduit-chip without a Dismiss RPC
  When I choose Dismiss in the phone composer warning row
  Then the checkout Dismiss RPC targets /workspace/conduit-chip
  And the phone composer warning row is absent
  And the phone composer amber dot is hidden
  And the workspace mismatch stays recorded at /workspace/conduit-chip after 1 Dismiss RPC
  When the session has a workspace mismatch at /workspace/conduit-chip
  Then the phone composer warning row is absent
  And the phone composer amber dot is hidden
  And the workspace mismatch stays recorded at /workspace/conduit-chip after 1 Dismiss RPC

Scenario: changed phone mismatch evidence restores a locally dismissed warning
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the composer checkout is conduit / account-chip as worktree
  And the session has a workspace mismatch at /workspace/conduit-chip
  When I open the phone composer sheet
  And I choose Dismiss in the phone composer warning row
  Then the phone composer warning row is absent
  And the phone composer amber dot is hidden
  When the session has a workspace mismatch at /workspace/conduit-other
  Then the phone composer warning row reports ../conduit-other and offers Move and Dismiss
  And the phone composer amber dot is visible
  And the workspace mismatch stays recorded at /workspace/conduit-other without a Dismiss RPC
  When the session has a workspace mismatch at /workspace/conduit-chip
  Then the phone composer warning row reports ../conduit-chip and offers Move and Dismiss
  And the phone composer amber dot is visible
  And the workspace mismatch stays recorded at /workspace/conduit-chip without a Dismiss RPC

Scenario Outline: every phone mode other than Ask stays visible as a hot shield
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are <mode>
  Then the phone hot shield is <visible> for <label>
  When I tap the phone composer Mode row
  Then the phone composer sheet keeps the Mode menu above it
  And the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full

Examples:
  | mode        | visible | label       |
  | dontAsk     | visible | Never ask   |
  | plan        | visible | Plan        |
  | ask         | hidden  | Ask         |
  | acceptEdits | visible | Edits       |
  | auto        | visible | Auto        |
  | full        | visible | Full access |

Scenario Outline: E3 phone draft keeps its context above the one-line composer
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And I start a new session
  And the composer uses icons controls
  And the Claude accounts are claude as personal, self as work
  And the composer picker has the Claude catalog
  When I set effort to high
  Then the phone icons line matches E1 with the default shield hidden
  And the composer region visually matches <closed> at <threshold> percent
  And the phone icons draft has no checkout and keeps context above the composer
  And the screen region visually matches <open> at <threshold> percent

Examples:
  | closed                  | open                    | threshold |
  | composer-icons-e3-phone | composer-icons-e3-sheet | 98        |

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

Scenario Outline: a thin desktop composer drops checkout labels instead of covering send
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the desktop composer is <width> pixels wide
  And the composer uses icons controls
  And the composer picker has the Claude catalog
  And the composer checkout is conduit / main as branch
  And the checkout has uncommitted changes, 14 ahead, 0 behind
  Then the composer checkout labels are <labels>
  And the icons checkout is a quiet shrinking control before send
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu shows conduit and main in full

Examples:
  | width | labels                    | baseline                     | threshold |
  | 520   | project, branch, upstream | composer-checkout-fit-full   | 98        |
  | 450   | branch, upstream          | composer-checkout-fit-branch | 98        |
  | 400   | none                      | composer-checkout-fit-icon   | 98        |

Scenario Outline: a thin desktop composer folds harness and model into one short control
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the desktop composer is <width> pixels wide
  And the composer uses icons controls
  And the composer picker has the Claude catalog
  And the composer checkout is conduit / main as branch
  And the checkout has uncommitted changes, 14 ahead, 0 behind
  Then the icons model control reads S5 beside the harness logo
  And the composer checkout labels are <labels>
  And the icons checkout is a quiet shrinking control before send after the combined model control
  And the composer region visually matches <baseline> at <threshold> percent
  When the desktop composer sits at the window's left edge
  And I tap the icons model control
  Then the icons control opens the picker at Model
  And the model picker stays inside the window

Examples:
  | width | labels                    | baseline           | threshold |
  | 380   | project, branch, upstream | composer-thin-full | 98        |
  | 256   | none                      | composer-thin-icon | 98        |

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
