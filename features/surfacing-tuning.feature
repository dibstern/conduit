Feature: Surfacing feedback tunes categories without applying proposals automatically

Scenario Outline: Fewer than five marks explains how to unlock proposals
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing tuning has <marks> marks and a valid key in the <theme> theme
  When I open settings to Surfacing
  And I open Surfacing Feedback
  Then Surfacing explains the five-mark proposal threshold with <marks> marks
  And the settings-panel region visually matches surfacing-feedback-<marks>-<viewport>-<theme> at <threshold> percent

Examples:
  | viewport | marks | theme | threshold |
  | desktop  | 0     | dark  | 98        |
  | desktop  | 4     | light | 98        |
  | phone    | 0     | light | 98        |
  | phone    | 4     | dark  | 98        |

Scenario Outline: The feedback ledger shows counts and clears one mark
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing tuning has 6 marks and a valid key in the <theme> theme
  When I open settings to Surfacing
  And I open Surfacing Feedback
  Then Surfacing shows feedback tiles and category counts
  And Surfacing ledger records are newest first with verdicts reasons and session titles
  And the settings-panel region visually matches surfacing-feedback-ledger-<viewport>-<theme> at <threshold> percent
  When I clear the newest Surfacing mark
  Then only that Surfacing mark is cleared

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | desktop  | light | 98        |
  | phone    | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: Proposals work without a TypeSafe key and paid scoring explains the missing key
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing tuning has 6 marks and a none key in the <theme> theme
  When I open settings to Surfacing
  And I open Surfacing Feedback
  And I request Surfacing changes
  Then Surfacing shows proposal diffs evidence and checked changes
  And Surfacing explains that definition scoring needs a TypeSafe key
  And the settings-panel region visually matches surfacing-feedback-no-key-<viewport>-<theme> at <threshold> percent

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: Proposals show loading failure retry and no-change states
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing tuning has 6 marks and a valid key in the <theme> theme
  And the next Surfacing proposal is <state>
  When I open settings to Surfacing
  And I open Surfacing Feedback
  And I request Surfacing changes
  Then Surfacing shows the <state> proposal state
  And the settings-panel region visually matches surfacing-proposal-<state>-<viewport>-<theme> at <threshold> percent
  Then Surfacing can recover from the <state> proposal state

Examples:
  | viewport | state   | theme | threshold |
  | desktop  | pending | dark  | 98        |
  | desktop  | failed  | light | 98        |
  | desktop  | empty   | dark  | 98        |
  | phone    | pending | light | 98        |
  | phone    | failed  | dark  | 98        |
  | phone    | empty   | light | 98        |

Scenario Outline: Review scores changes and applies only checked hunks
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing tuning has 6 marks and a valid key in the <theme> theme
  When I open settings to Surfacing
  And I open Surfacing Feedback
  And I request Surfacing changes
  Then Surfacing shows proposal diffs evidence and checked changes
  And scoring a proposal definition requires an explicit paid test
  And the settings-panel region visually matches surfacing-proposal-review-<viewport>-<theme> at <threshold> percent
  When I exclude the Milestone change and apply the Surfacing proposal
  Then only checked category changes are saved at the next version

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | desktop  | light | 98        |
  | phone    | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: Propose again carries rejected hunks and Dismiss stores no proposal
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing tuning has 6 marks and a valid key in the <theme> theme
  When I open settings to Surfacing
  And I open Surfacing Feedback
  And I request Surfacing changes
  And I exclude the Milestone change and propose again
  Then the next Surfacing request avoids only the rejected change
  When I dismiss the Surfacing proposal
  Then the proposal is gone and no categories were saved

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | light |

Scenario Outline: A stale proposal reloads categories and asks for a new proposal
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing tuning has 6 marks and a valid key in the <theme> theme
  When I open settings to Surfacing
  And I open Surfacing Feedback
  And I request Surfacing changes
  And categories change elsewhere before the Surfacing proposal is applied
  Then Surfacing reloads the changed categories and asks for another proposal
  And the settings-panel region visually matches surfacing-proposal-stale-<viewport>-<theme> at <threshold> percent

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: Category preview debounces free weights and prices definition tests
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Surfacing tuning has 6 marks and a valid key in the <theme> theme
  When I open settings to Surfacing
  And I open Surfacing Categories
  Then weight preview is debounced and makes no paid Jev call
  And definition preview shows its call count before an explicit test
  And the settings-panel region visually matches surfacing-category-preview-<viewport>-<theme> at <threshold> percent

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | desktop  | light | 98        |
  | phone    | dark  | 98        |
  | phone    | light | 98        |
