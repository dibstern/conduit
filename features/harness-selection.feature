
Feature: Harness is selected in the picker root and fixed at creation

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: selecting a Harness tab sets the harness for a new session
  When I open the model picker
  And I select the <harness> Harness tab in the picker
  And I close the model picker
  And I type <message> into the composer
  And I send the composer message
  Then a session is created on the <harness> harness

Examples:
  | harness  | message       |
  | Claude   | plan the work |
  | OpenCode | fix the bug   |

Scenario Outline: the composer trigger shows the bound instance icon
  Given a session already exists on the <harness> harness
  Then the model trigger shows the <harness> instance icon

Examples:
  | harness  |
  | Claude   |
  | OpenCode |

Scenario Outline: C2 Harness tabs are locked once a session exists
  Given a session already exists on the <harness> harness
  And the harness logo is viewed in the <tier> tier
  When I open the model picker
  And I view Harness choices in the picker
  Then the <harness> Harness tab is selected and in view
  And the other Harness tabs are locked and announce Harness is fixed for this session
  And the picker subtitle is this session
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I move to the next Harness with the keyboard
  Then the <harness> Harness tab is selected and in view

Examples:
  | harness  | tier  | baseline                           | threshold |
  | Claude   | wide  | composer-picker-harness-c2-claude   | 98        |
  | Claude   | phone | composer-picker-harness-c2-claude   | 98        |
  | OpenCode | wide  | composer-picker-harness-c2-opencode | 98        |
  | OpenCode | phone | composer-picker-harness-c2-opencode | 98        |

Scenario: C2 a named instance of a future driver locks the correct Harness tab
  Given the configured Harness choices are Claude, OpenCode, Codex
  And a session is bound to the Codex instance codex-work
  When I view Harness choices in the picker
  Then the Codex Harness tab is selected and in view
  And the other Harness tabs are locked and announce Harness is fixed for this session
  And the picker subtitle is this session
  When I move to the next Harness with the keyboard
  Then the Codex Harness tab is selected and in view

Scenario Outline: the model picker matches the approved layout
  When I open the model picker
  And I select the <harness> Harness tab in the picker
  Then the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | harness | baseline                      | threshold |
  | Claude  | model-picker-rail-claude-dark | 98        |

Scenario Outline: B1 one instance has no badge in the composer or picker
  Given a session already exists on the <harness> harness
  And the harness logo is viewed in the <tier> tier
  And the composer uses <controls> controls
  Then the composer harness logo for <account> has no badge
  When I open the model picker
  Then the picker harness logo for <account> has no badge
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I view Harness choices in the picker
  Then the picker harness logo for <account> has no badge

Examples:
  | tier  | harness  | controls | account  | baseline                           | threshold |
  | wide  | Claude   | icons    | claude   | harness-logo-single-claude-icons   | 98        |
  | phone | Claude   | icons    | claude   | harness-logo-single-claude-icons   | 98        |
  | wide  | Claude   | words    | claude   | harness-logo-single-claude-words   | 98        |
  | phone | Claude   | words    | claude   | harness-logo-single-claude-words   | 98        |
  | wide  | OpenCode | icons    | opencode | harness-logo-single-opencode-icons | 98        |
  | phone | OpenCode | icons    | opencode | harness-logo-single-opencode-icons | 98        |
  | wide  | OpenCode | words    | opencode | harness-logo-single-opencode-words | 98        |
  | phone | OpenCode | words    | opencode | harness-logo-single-opencode-words | 98        |

Scenario Outline: B1 the implicit default Claude account counts and shows C
  Given a session already exists on the Claude harness
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are self as personal
  And the composer uses <controls> controls
  Then the composer harness logo for claude shows C on its badge
  When I open the model picker
  Then the picker harness logo for claude shows C on its badge
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I view Account choices in the picker
  Then the picker card claude is named Claude and shows its AccountDot
  And the picker card self is named personal and shows its AccountDot

Examples:
  | tier   | controls | baseline                          | threshold |
  | wide   | icons    | harness-logo-default-claude-icons | 98        |
  | narrow | icons    | harness-logo-default-claude-narrow | 98        |
  | phone  | icons    | harness-logo-default-claude-icons | 98        |
  | wide   | words    | harness-logo-default-claude-words | 98        |
  | phone  | words    | harness-logo-default-claude-words | 98        |

Scenario Outline: B1 a resumed account's letter and colour match its AccountDot
  Given a session already exists on the Claude harness
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as Claude, self as personal, team as Work
  And the transcript ends with the unanswered message Check the account logo
  And the composer uses <controls> controls
  When the session resumes on <account> from claude by user and replies Ready on this account.
  Then the composer harness logo for <account> shows <letter> on its badge
  And the composer harness badge for <account> matches its AccountDot colour
  When I open the model picker
  Then the picker harness logo for <account> shows <letter> on its badge
  And the picker harness badge for <account> matches its AccountDot colour
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I view Account choices in the picker
  Then the picker card self is named personal and shows its AccountDot
  And the picker card team is named Work and shows its AccountDot
  And the <account> Account card is selected and in view

Examples:
  | tier  | controls | account | letter | baseline                         | threshold |
  | wide  | icons    | self    | P      | harness-logo-personal-icons      | 98        |
  | phone | icons    | team    | W      | harness-logo-work-icons          | 98        |
  | wide  | words    | team    | W      | harness-logo-work-words          | 98        |
  | phone | words    | self    | P      | harness-logo-personal-words      | 98        |

Scenario Outline: B1 OpenCode badges both its default and named instance when there are two
  Given a session already exists on the OpenCode harness
  And the harness logo is viewed in the <tier> tier
  And a named OpenCode instance Bedrock is already configured
  And the composer uses <controls> controls
  Then the composer harness logo for opencode shows O on its badge
  When I open the model picker
  Then the picker harness logo for opencode shows O on its badge
  When I view Instance choices in the picker
  Then the picker card opencode is named OpenCode and shows its AccountDot
  And the picker card bedrock is named Bedrock and shows its AccountDot
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | tier  | controls | baseline                          | threshold |
  | wide  | icons    | harness-logo-opencode-multi-icons | 98        |
  | phone | icons    | harness-logo-opencode-multi-icons | 98        |
  | wide  | words    | harness-logo-opencode-multi-words | 98        |
  | phone | words    | harness-logo-opencode-multi-words | 98        |

Scenario Outline: B1 switching replaces the letter with a spinner and restores the landed account
  Given a session already exists on the Claude harness
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as Claude, self as personal
  And the composer uses <controls> controls
  And the quota check reads claude 40% used, self 23% used
  And the handoff carries 2 of 2 messages with the first
  And the transcript ends with the unanswered message Switch the account
  And the account switch reply is held
  When I view Account choices in the picker
  And I select the self Account card
  Then the PreviewContinuation RPC previews the current session on self
  And the model picker is closed before the handoff dialog
  And the handoff dialog asks Continue on personal?
  When I press Switch and continue
  Then the ContinueSession RPC switches the current session from claude to self
  And the composer harness badge for claude is spinning
  When the account switch reply lands
  Then the handoff dialog is closed
  When the session resumes on self from claude by user and replies Switched accounts.
  Then the composer harness logo for self shows P on its badge
  And the composer harness badge for self is idle
  When I open the model picker
  Then the picker harness logo for self shows P on its badge
  And the picker harness badge for self is idle
  And the composer harness badge for self matches its AccountDot colour
  And the picker harness badge for self matches its AccountDot colour

Examples:
  | tier   | controls |
  | wide   | icons    |
  | narrow | icons    |
  | phone  | icons    |
  | wide   | words    |
  | narrow | words    |
  | phone  | words    |
