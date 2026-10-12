Feature: Composer approval controls open the ranked mode menu

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

Scenario: Claude-only modes are absent from an OpenCode phone menu
  Given the viewport is a phone
  And a session already exists on the OpenCode harness
  When I tap the phone composer Mode row
  Then the approvals menu is ranked ask, acceptEdits, full
  And the approvals dropdown does not offer auto
  And the approvals dropdown does not offer plan
  And the approvals dropdown does not offer dontAsk

Scenario Outline: the Claude phone Mode row changes the mode and keeps the sheet open
  Given the viewport is a phone
  And a session already exists on the Claude harness
  And approvals are ask
  When I tap the phone composer Mode row
  And I set approvals to <mode>
  Then the phone composer Mode row reads <label>
  And the approvals menu is closed
  When I close the phone composer sheet
  Then the phone hot shield is <visible> for <label>

Examples:
  | mode        | label       | visible |
  | dontAsk     | Never ask   | visible |
  | plan        | Plan        | visible |
  | ask         | Ask         | hidden  |
  | acceptEdits | Edits       | visible |
  | auto        | Auto        | visible |
  | full        | Full access | visible |

Scenario Outline: the OpenCode phone Mode row selects Ask, Edits and Full access
  Given the viewport is a phone
  And a session already exists on the OpenCode harness
  And approvals are ask
  When I tap the phone composer Mode row
  Then the approvals menu is ranked ask, acceptEdits, full
  When I set approvals to <mode>
  Then the phone composer Mode row reads <label>
  And the approvals menu is closed
  When I close the phone composer sheet
  Then the phone hot shield is <visible> for <label>

Examples:
  | mode        | label       | visible |
  | ask         | Ask         | hidden  |
  | acceptEdits | Edits       | visible |
  | full        | Full access | visible |

Scenario: the phone mode menu offers ranked descriptions without changing Ask on open
  Given the viewport is a phone
  And a session already exists on the Claude harness
  And approvals are ask
  Then the phone hot shield is hidden for Ask
  When I tap the phone composer Mode row
  Then the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full
  And the phone composer Mode row reads Ask
  And the approvals option dontAsk describes Denies anything not pre-approved.
  And the approvals option plan describes Reads and proposes. No edits.
  And the approvals option ask describes Asks before each edit or command.
  And the approvals option acceptEdits describes File edits run without asking.
  And the approvals option auto describes A model approves or denies each action.
  And the approvals option full describes Everything runs. No prompts.
  And only dontAsk, plan and auto carry Claude tags
  When I set approvals to full
  Then the phone composer Mode row reads Full access
  And the approvals menu is closed

Scenario Outline: an auto-approving session is visibly flagged
  Given the viewport is a desktop
  When I set approvals to <mode>
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | mode | baseline                    | threshold |
  | full | composer-approvals-full-dark | 98        |

Scenario Outline: the phone Full access shield stays visible beside more
  Given the viewport is a phone
  And a session already exists on the Claude harness
  And approvals are full
  Then the phone hot shield is visible for Full access
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                   | threshold |
  | composer-approvals-full-phone | 98     |
