Feature: Words composer says what on the left and where on the right at every width

Scenario Outline: phone Settings selects Words and reload keeps the preference
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the Composer tab
  And I choose Words for composer controls
  Then the composer words row shows S5, no window, DEF and ask
  And the composer icon controls are absent
  And the words row is below the composer border
  When I reload the Words composer
  Then the composer words row shows S5, no window, DEF and ask
  And the composer icon controls are absent
  And the words row is below the composer border
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                      | threshold |
  | composer-controls-words-phone | 98        |

Scenario Outline: phone effort word opens the shared picker at Effort
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the Composer tab
  And I choose Words for composer controls
  Then the effort word shows DEF
  When I tap the effort word
  Then the word opens the picker at Effort
  And the picker lists every effort level including xhigh
  When I set effort to high
  And I close the model picker
  Then the effort word shows high
  And the effort menu is closed
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                            | threshold |
  | composer-controls-words-effort-phone | 98        |

Scenario Outline: phone approvals word opens the existing mode menu on tap
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are plan
  When I open settings to the Composer tab
  And I choose Words for composer controls
  Then the approvals word shows plan
  And the approvals word uses the plan tone
  When I tap the approvals word
  Then the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full
  And the approvals word shows plan
  When I set approvals to acceptEdits
  Then the approvals word shows edits
  And the approvals word uses the edits tone
  And the approvals menu is closed
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                               | threshold |
  | composer-controls-words-approvals-phone | 98        |

Scenario Outline: phone model word opens Model in the shared P2 bottom sheet
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the Composer tab
  And I choose Words for composer controls
  And I tap the model word
  Then the word opens the picker at Model
  When I go Back in the picker
  Then the picker is a phone bottom sheet
  And the picker root shows Claude and Sonnet 5
  And the picker offers context windows 200k, 1m
  And the picker lists every effort level including xhigh
  When I close the model picker
  Then the composer words row shows S5, no window, DEF and ask
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                            | threshold |
  | composer-controls-words-picker-phone | 98        |

Scenario Outline: desktop renders Words below the composer border
  Given the viewport is a desktop
  And the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the Composer tab
  And I choose Words for composer controls
  Then the composer words row shows Sonnet 5, 200K, DEF and ask
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
  And the composer checkout shows conduit / account-chip with a worktree icon
  And the words row keeps what on the left and checkout then 42% on the right
  And the words row is below the composer border
  And the composer icon controls are absent
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | tier   | model    | window    | account  | baseline                 | threshold |
  | wide   | Sonnet 5 | 200K      | personal | composer-words-d1-wide   | 98        |
  | narrow | Sonnet 5 | 200K      | absent   | composer-words-d1-narrow | 98        |
  | phone  | S5       | no window | absent   | composer-words-d1-phone  | 98        |

Scenario: phone words row shows the project
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the phone tier
  And the composer checkout is conduit / account-chip as worktree
  And approvals are ask
  And the composer uses words controls
  Then the composer words row shows S5, no window, DEF and ask
  And the composer checkout shows conduit / account-chip with a worktree icon
  And the words row context usage is absent

Scenario Outline: the phone words row keeps a non-default context window
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the phone tier
  And approvals are ask
  And the composer uses words controls
  When I tap the badge word
  And I select context window 1m in the picker
  And I close the model picker
  Then the composer words row shows S5, 1M, DEF and ask
  When I tap the window word
  Then the word opens the picker at Model
  When I close the model picker
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                      | threshold |
  | composer-words-window-1m-phone | 98        |

Scenario Outline: D2 long names truncate project first and stay complete in the checkout menu
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
  Then the composer checkout truncates the project before the branch
  And the words row keeps what on the left and checkout then 42% on the right
  And the composer region visually matches <baseline> at <threshold> percent
  When I open the composer checkout menu
  Then the composer checkout menu shows conduit-worktrees and feature/session-account-chip-redesign in full

Examples:
  | tier   | baseline                 | threshold |
  | narrow | composer-words-d2-narrow | 98        |
  | phone  | composer-words-d2-phone  | 98        |

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
  | phone  | hidden  | composer-words-d3-git-phone  | 98        |

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
  | phone  | Move    | composer-words-d3-hint-phone  | 98        |
  | wide   | Dismiss | composer-words-d3-hint-wide   | 98        |
  | narrow | Dismiss | composer-words-d3-hint-narrow | 98        |
  | phone  | Dismiss | composer-words-d3-hint-phone  | 98        |

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
  | phone  | composer-words-d3-mismatch-phone  | 98        |

Scenario Outline: D4 one Claude account has no badge or account word
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as personal
  And the composer checkout is conduit / main as branch
  And the composer uses words controls
  Then the composer harness logo for claude has no badge
  And the composer account word is absent
  And the composer checkout shows conduit / main with a branch icon
  And the words row context usage is absent
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | tier   | baseline                       | threshold |
  | wide   | composer-words-d4-single-wide   | 98        |
  | narrow | composer-words-d4-single-narrow | 98        |
  | phone  | composer-words-d4-single-phone  | 98        |

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
  | narrow | absent  | composer-words-d4-opencode-narrow | 98        |
  | phone  | absent  | composer-words-d4-opencode-phone  | 98        |

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
  When I open the account pill in the session bar
  And I pick work in the account picker
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
  | narrow | absent  | absent |
  | phone  | absent  | absent |

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
  | phone  | above    | composer-words-d4-draft-phone  | 98        |

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
  | phone  | badge   | Account |
  | wide   | account | Account |
  | wide   | model   | Model   |
  | narrow | model   | Model   |
  | phone  | model   | Model   |
  | wide   | window  | Model   |
  | narrow | window  | Model   |
  | wide   | effort  | Effort  |
  | narrow | effort  | Effort  |
  | phone  | effort  | Effort  |

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
  | phone  |

Scenario Outline: checkout icons distinguish a worktree, branch, commit and folder
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the harness logo is viewed in the phone tier
  And the composer checkout is conduit / <branch> as <kind>
  And the composer uses words controls
  Then the composer checkout shows conduit / <branch> with a <icon> icon

Examples:
  | branch       | kind     | icon     |
  | account-chip | worktree | worktree |
  | main         | branch   | branch   |
  | abc1234      | detached | commit   |
  | none         | folder   | folder   |
