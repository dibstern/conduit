Feature: Words composer keeps individual desktop controls and one phone sheet

Scenario: phone checkout copies its branch and full commit hash
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the composer checkout is conduit / account-chip as worktree
  And the composer uses words controls
  When I tap the phone composer Checkout row
  And I tap the checkout Branch copy control
  Then the checkout shows Branch copied and the clipboard contains account-chip
  When I tap the checkout HEAD row
  Then the checkout shows Commit hash copied and the clipboard contains 6b11104a9c2e88d27395d13c706d876fbab99aa1

Scenario Outline: phone Settings selects Words and reload keeps the summary
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the General section
  And I choose Words for composer controls
  And I set effort to high
  Then the phone Words summary reads Sonnet 5, 200K, high and ask
  And the composer icon controls are absent
  And the words row is below the composer border
  When I reload the Words composer
  And I set effort to high
  Then the phone Words summary reads Sonnet 5, 200K, high and ask
  And the composer icon controls are absent
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                      | threshold |
  | composer-controls-words-phone | 98        |

Scenario Outline: phone Words opens every picker through one Composer sheet
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the Claude accounts are claude as personal, work as work
  And the composer checkout is conduit / account-chip as worktree
  And the composer uses words controls
  When I open the phone composer sheet
  Then the phone composer sheet has separate Harness, Account, Model, Effort, Permissions and Checkout rows
  When I tap the phone composer <row> row
  Then the phone composer sheet gives way to the picker
  And the icons control opens the picker at <section>
  When I close the model picker
  Then the phone Words summary is focused

Examples:
  | row     | section |
  | Harness | Harness |
  | Account | Account |
  | Model   | Model   |
  | Effort  | Effort  |

Scenario Outline: phone Words effort is changed through its sheet
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  And the composer uses words controls
  When I tap the phone composer Effort row
  Then the picker lists every effort level including xhigh
  When I set effort to high
  And I close the model picker
  Then the phone Words summary reads Sonnet 5, 200K, high and ask
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                            | threshold |
  | composer-controls-words-effort-phone | 98        |

Scenario Outline: phone Words mode is changed through its sheet
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are plan
  And the composer uses words controls
  When I tap the phone composer Permissions row
  Then the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full
  And the phone composer Permissions row reads Plan
  When I set approvals to acceptEdits
  Then the phone composer Permissions row reads Auto-accept edits
  And the approvals menu is closed
  When I close the phone composer sheet
  Then the phone Words mode is edits with the edits tone
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                               | threshold |
  | composer-controls-words-approvals-phone | 98        |

Scenario Outline: phone Words keeps a selected context window in the summary
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  And the composer uses words controls
  When I tap the phone composer Model row
  And I go Back in the picker
  And I select context window 1m in the picker
  And I set effort to high
  And I close the model picker
  Then the phone Words summary reads Sonnet 5, 1M, high and ask
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                      | threshold |
  | composer-words-window-1m-phone | 98        |

Scenario Outline: phone Words keeps checkout details and warnings in its sheet
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the composer checkout is conduit-worktrees / feature/session-account-chip-redesign as worktree
  And the checkout has uncommitted changes, 2 ahead, 1 behind and a rebase in progress
  And the session has a workspace hint at /workspace/conduit-hint
  And the composer uses words controls
  And the mock relay reports context 42 percent
  Then the phone Words row omits checkout and shows 42% context
  When I open the phone composer sheet
  Then the phone composer warning row reports Claude is working in ../conduit-hint and offers Move and Dismiss
  And the screen region visually matches <baseline> at <threshold> percent
  When I tap the phone composer Checkout row
  Then the composer checkout menu shows conduit-worktrees and feature/session-account-chip-redesign in full
  And the composer checkout menu shows uncommitted changes and upstream 2 ahead and 1 behind

Examples:
  | baseline                      | threshold |
  | composer-words-checkout-sheet | 98        |

Scenario: phone Words drafts keep new-session context above their one-row box
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer uses words controls
  And I start a new session
  Then the composer has 1 row
  And the phone Words row has no checkout
  And the words row is below the composer border

Scenario Outline: desktop renders Words below the composer border
  Given the viewport is a desktop
  And the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the General section
  And I choose Words for composer controls
  Then the composer words row shows Sonnet 5, 200K, default and ask
  And the composer icon controls are absent
  And the words row is below the composer border
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                       | threshold |
  | composer-controls-words-desktop | 98        |

Scenario Outline: D1 the words row keeps what and where at every composer tier
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as personal, work as work
  And the composer checkout is conduit / account-chip as worktree
  And approvals are ask
  And the composer uses words controls
  And the mock relay reports context 42 percent
  When I tap the effort word
  And I set effort to high
  And I close the model picker
  Then the composer words row shows <model>, <window>, high and ask
  And the composer account word is <account>
  And the composer harness logo for claude shows P on its badge
  And the Words checkout shows account-chip with a worktree icon and names conduit
  And the words row keeps what on the left and checkout then 42% on the right
  And the words row is below the composer border
  And the composer icon controls are absent
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | tier   | model    | window    | account  | baseline                 | threshold |
  | wide   | Sonnet 5 | 200K      | personal | composer-words-d1-wide   | 98        |
  | narrow | Sonnet 5 | 200K      | personal   | composer-words-d1-narrow | 98        |

Scenario Outline: long Words checkout branches truncate and stay complete in their menu
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as personal, work as work
  And the composer checkout is conduit-worktrees / feature/session-account-chip-redesign as worktree
  And approvals are ask
  And the composer uses words controls
  And the mock relay reports context 42 percent
  When I tap the effort word
  And I set effort to high
  And I close the model picker
  Then the Words checkout truncates its branch and retains its full identity
  And the words row keeps what on the left and checkout then 42% on the right
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu shows conduit-worktrees and feature/session-account-chip-redesign in full

Examples:
  | tier   | baseline                 | threshold |
  | narrow | composer-words-d2-narrow | 98        |

Scenario Outline: D3 dirty, ahead and rebasing marks survive every width
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as personal, work as work
  And the composer checkout is conduit / account-chip as worktree
  And the checkout has uncommitted changes, 2 ahead, 1 behind and a rebase in progress
  And approvals are ask
  And the composer uses words controls
  Then the composer checkout shows uncommitted, rebasing and <counts> upstream counts
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu shows uncommitted changes and upstream 2 ahead and 1 behind

Examples:
  | tier   | counts  | baseline                    | threshold |
  | wide   | visible | composer-words-d3-git-wide   | 98        |
  | narrow | visible | composer-words-d3-git-narrow | 98        |

Scenario: two workspace notices share one git chip warning mark
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the wide tier
  And the composer checkout is conduit / account-chip as worktree
  And the session has a workspace hint at /workspace/conduit-hint
  And the session has a workspace mismatch at /workspace/conduit-actual
  And the composer uses words controls
  Then the composer checkout has exactly one warning mark naming Workspace mismatch: Claude is working in /workspace/conduit-actual and working in conduit-hint?
  When I open the composer checkout menu
  Then the composer checkout menu reports /workspace/conduit-actual and offers Retry move
  And the composer checkout menu offers Move and Dismiss for /workspace/conduit-hint

Scenario Outline: D3 workspace hints show an icon and put Move and Dismiss in the menu at every width
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the composer checkout is conduit / account-chip as worktree
  And the session has a workspace hint at /workspace/conduit-hint
  And the composer uses words controls
  Then the composer checkout has a workspace hint icon without inline actions
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu offers Move and Dismiss for /workspace/conduit-hint
  When I choose <action> in the composer checkout menu
  Then the checkout <action> RPC targets /workspace/conduit-hint

Examples:
  | tier   | action  | baseline                     | threshold |
  | wide   | Move    | composer-words-d3-hint-wide   | 98        |
  | narrow | Move    | composer-words-d3-hint-narrow | 98        |
  | wide   | Dismiss | composer-words-d3-hint-wide   | 98        |
  | narrow | Dismiss | composer-words-d3-hint-narrow | 98        |

Scenario Outline: D3 workspace mismatches show an icon and keep the retry in the menu at every width
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the composer checkout is conduit / account-chip as worktree
  And the session has a workspace mismatch at /workspace/conduit-actual
  And the composer uses words controls
  Then the composer checkout has a workspace mismatch icon without inline actions
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu reports /workspace/conduit-actual and offers Retry move
  When I choose Retry move in the composer checkout menu
  Then the checkout Retry move RPC targets /workspace/conduit

Examples:
  | tier   | baseline                         | threshold |
  | wide   | composer-words-d3-mismatch-wide   | 98        |
  | narrow | composer-words-d3-mismatch-narrow | 98        |

Scenario Outline: one Claude account keeps its account word without a badge
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as personal
  And the composer checkout is conduit / main as branch
  And the composer uses words controls
  Then the composer harness logo for claude has no badge
  And the composer account word is personal
  And the Words checkout shows main with a branch icon and names conduit
  And the words row context usage is absent
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | tier   | baseline                       | threshold |
  | wide   | composer-words-d4-single-wide   | 98        |
  | narrow | composer-words-d4-single-narrow | 98        |

Scenario Outline: D4 two OpenCode instances show the instance word and use the agent instead of mode
  Given the conduit app is served with the connected mockup
  And a session already exists on the OpenCode harness
  And a named OpenCode instance Bedrock is already configured
  And the words session uses the OpenCode instance Bedrock
  And the composer picker has the OpenCode catalog
  And the harness logo is viewed in the <tier> tier
  And the composer checkout is conduit / account-chip as worktree
  And the composer uses words controls
  Then the composer harness logo for bedrock shows B on its badge
  And the composer account word is <account>
  And the composer agent word is build and replaces approvals
  And the composer region visually matches <baseline> at <threshold> percent
  When I tap the agent word
  Then the word opens the picker at Agent

Examples:
  | tier   | account | baseline                         | threshold |
  | wide   | Bedrock | composer-words-d4-opencode-wide   | 98        |
  | narrow | Bedrock | composer-words-d4-opencode-narrow | 98        |

Scenario Outline: D4 switching shows the target account with an ellipsis and a spinning badge
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as personal, work as work
  And the composer uses words controls
  And the quota check reads claude 40% used, work 23% used
  And the handoff carries 2 of 2 messages with the first
  And the transcript ends with the unanswered message Switch the account
  And the account switch reply is held
  When I view Account choices in the picker
  And I select the work Account card
  And I press Switch and continue
  Then the ContinueSession RPC switches the current session from claude to work
  And the composer account word is <account>
  And the composer harness badge for claude is spinning
  When the account switch reply lands
  And the session resumes on work from claude by user and replies Switched accounts.
  Then the composer harness logo for work shows W on its badge
  And the composer account word is <landed>
  And the composer harness badge for work is idle

Examples:
  | tier   | account | landed |
  | wide   | work…   | work   |
  | narrow | work…   | work   |

Scenario Outline: D4 drafts have no checkout and retain the new-session context
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the composer uses words controls
  And I start a new session
  Then the words draft has an empty right group and keeps context <position> the composer
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | tier   | position | baseline                      | threshold |
  | wide   | below    | composer-words-d4-draft-wide   | 98        |
  | narrow | below    | composer-words-d4-draft-narrow | 98        |

Scenario Outline: every words picker trigger opens its own section
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as personal, work as work
  And the composer uses words controls
  When I tap the <word> word
  Then the word opens the picker at <section>

Examples:
  | tier   | word    | section |
  | wide   | badge   | Account |
  | narrow | badge   | Account |
  | wide   | account | Account |
  | wide   | model   | Model   |
  | narrow | model   | Model   |
  | wide   | window  | Model   |
  | narrow | window  | Model   |
  | wide   | effort  | Effort  |
  | narrow | effort  | Effort  |

Scenario Outline: every approvals word opens today's mode menu without cycling
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And approvals are ask
  And the composer uses words controls
  When I tap the approvals word
  Then the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full
  And the approvals word shows ask

Examples:
  | tier   |
  | wide   |
  | narrow |

Scenario Outline: checkout icons distinguish a worktree, branch, commit and folder
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the harness logo is viewed in the narrow tier
  And the composer checkout is conduit / <branch> as <kind>
  And the composer uses words controls
  Then the Words checkout shows <branch> with a <icon> icon and names conduit

Examples:
  | branch       | kind     | icon     |
  | account-chip | worktree | worktree |
  | main         | branch   | branch   |
  | abc1234      | detached | commit   |
  | none         | folder   | folder   |
