Feature: Composer approvals shield cycles modes and opens a ranked hold menu

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: selecting an approvals option updates the desktop chip
  Given the viewport is a desktop
  When I set approvals to <mode>
  Then the approvals chip shows <label>
  And the approvals menu is closed

Examples:
  | mode        | label       |
  | full        | Full access |
  | acceptEdits | Edits       |
  | ask         | Ask         |

Scenario: Claude-only modes are absent from an OpenCode menu
  Given the viewport is a phone
  And a session already exists on the OpenCode harness
  When I hold the approvals shield
  Then the approvals menu is ranked ask, acceptEdits, full
  And the approvals dropdown does not offer auto
  And the approvals dropdown does not offer plan
  And the approvals dropdown does not offer dontAsk

Scenario: the Claude phone cycle wraps in R1 order
  Given the viewport is a phone
  And a session already exists on the Claude harness
  And approvals are plan
  Then the approvals shield shows PLAN
  When I tap the approvals shield
  Then the approvals shield shows ASK
  And the approvals menu is closed
  When I tap the approvals shield
  Then the approvals shield shows EDITS
  When I tap the approvals shield
  Then the approvals shield shows AUTO
  When I tap the approvals shield
  Then the approvals shield shows FULL
  When I tap the approvals shield
  Then the approvals shield shows NEVER
  When I tap the approvals shield
  Then the approvals shield shows PLAN
  And the approvals menu is closed

Scenario: the OpenCode phone cycle wraps through Ask, Edits and Full access
  Given the viewport is a phone
  And a session already exists on the OpenCode harness
  And approvals are ask
  Then the approvals shield shows ASK
  When I tap the approvals shield
  Then the approvals shield shows EDITS
  When I tap the approvals shield
  Then the approvals shield shows FULL
  When I tap the approvals shield
  Then the approvals shield shows ASK
  And the approvals menu is closed

Scenario: holding opens the ranked menu without cycling and selection closes it
  Given the viewport is a phone
  And a session already exists on the Claude harness
  And approvals are ask
  Then the approvals shield shows ASK
  When I hold the approvals shield
  Then the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full
  And the approvals shield shows ASK
  And the approvals option dontAsk describes Denies anything not pre-approved.
  And the approvals option plan describes Reads and proposes. No edits.
  And the approvals option ask describes Asks before each edit or command.
  And the approvals option acceptEdits describes File edits run without asking.
  And the approvals option auto describes A model approves or denies each action.
  And the approvals option full describes Everything runs. No prompts.
  And only dontAsk, plan and auto carry Claude tags
  When I set approvals to full
  Then the approvals shield shows FULL
  And the approvals menu is closed

Scenario Outline: every mode has its own tone and only relaxed approvals are tinted
  Given the viewport is a phone
  And a session already exists on the Claude harness
  And approvals are <mode>
  Then the approvals shield shows <label>
  And the approvals shield uses the <tone> tone with tint <tinted>

Examples:
  | mode        | label | tone  | tinted |
  | dontAsk     | NEVER | never | false  |
  | plan        | PLAN  | plan  | false  |
  | ask         | ASK   | ask   | false  |
  | acceptEdits | EDITS | edits | true   |
  | auto        | AUTO  | auto  | true   |
  | full        | FULL  | full  | true   |

Scenario Outline: an auto-approving session is visibly flagged
  Given the viewport is a desktop
  When I set approvals to <mode>
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | mode | baseline                    | threshold |
  | full | composer-approvals-full-dark | 98        |

Scenario Outline: the phone shield shows Full access with its micro label
  Given the viewport is a phone
  And a session already exists on the Claude harness
  And approvals are full
  Then the approvals shield shows FULL
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                   | threshold |
  | composer-approvals-full-phone | 98     |
