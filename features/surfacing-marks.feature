Feature: Surfacing marks correct one message with a reason and a reversible absolute level

Scenario Outline: Raise uses the most popular reasons for its direction and changes only the chosen message
  Given a surfacing marks ledger is available in the <theme> theme
  And message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then the surfacing marks theme is applied
  When I set the surfacing level to All
  And I Raise surfaced message #3 from the card
  Then the mark Why row proposes Raise #3 from all to balanced
  And the Why row offers the three most used raise reasons
  And the Why row keeps phone touch targets and wraps its prompt above chips
  And the messages region visually matches <whyBaseline> at <threshold> percent
  When I save the mark with reason chip changed the plan
  Then message #3 has an absolute balanced raise mark with reason changed the plan
  And the card and pin for #3 show the ▲ mark with reason changed the plan
  And the surfacing mark toast says ▲ Raised #3 to Balanced
  When I set the surfacing level to Balanced
  Then the surfacing pins are 1,2,3,4,5,8 and level counts are Key 3, Balanced 6, All 6
  And the messages region visually matches <savedBaseline> at <threshold> percent
  When I undo the surfacing mark
  Then the surfacing mark for #3 is cleared
  When I pick surfaced message #1
  Then the surfaced card shows #1 and announces its category and position
  And the surfacing pins are 1,2,4,5,8 and level counts are Key 3, Balanced 5, All 6

Examples:
  | viewport | theme | whyBaseline                     | savedBaseline                  | threshold |
  | desktop  | dark  | marks-raise-why-desktop-dark     | marks-raised-desktop-dark      | 98        |
  | phone    | dark  | marks-raise-why-phone-dark       | marks-raised-phone-dark        | 98        |
  | desktop  | light | marks-raise-why-desktop-light    | marks-raised-desktop-light     | 98        |
  | phone    | light | marks-raise-why-phone-light      | marks-raised-phone-light       | 98        |

Scenario Outline: Lower from All keeps the card open in the log and pressing the active mark clears it
  Given a surfacing marks ledger is available in the <theme> theme
  And message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I Lower surfaced message #3 from the card
  Then the mark Why row proposes Lower #3 from all to hidden
  And the Why row offers the three most used lower reasons
  When I save the mark without a reason
  Then message #3 has an absolute hidden lower mark with no reason
  And message #3 stays open marked hidden at this level
  And the surfacing mark toast says ▼ Lowered #3
  When I press the active Lower mark again
  Then the surfacing mark for #3 is cleared
  When I undo the surfacing mark
  Then message #3 has an absolute hidden lower mark with no reason
  And message #3 stays open marked hidden at this level

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | dark  |
  | desktop  | light |
  | phone    | light |

Scenario Outline: Enter saves a free text reason and Undo restores the previous absolute mark
  Given a surfacing marks ledger is available in the <theme> theme
  And message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I Lower surfaced message #1 from the card
  And I save the mark without a reason
  Then message #1 has an absolute all lower mark with no reason
  When I Raise surfaced message #1 from the card
  And I save the mark with free text users need this result before continuing
  Then message #1 has an absolute balanced raise mark with reason users need this result before continuing
  And the card and pin for #1 show the ▲ mark with reason users need this result before continuing
  When I undo the surfacing mark
  Then message #1 has an absolute all lower mark with no reason

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | dark  |
  | desktop  | light |
  | phone    | light |

Scenario Outline: Retype chooses an active category before asking why and stores its weighted level
  Given a surfacing marks ledger is available in the <theme> theme
  And message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I Retype surfaced message #3 from the card
  Then the retype menu offers active categories and hides retired categories
  When I retype the message as risk
  Then the Why row offers the three most used retype reasons
  When I save the mark with reason chip wrong category
  Then message #3 has an absolute key retype mark with reason wrong category
  And the saved mark category is risk
  And the card and pin for #3 show the ⇄ mark with reason wrong category
  And the surfacing mark toast says ⇄ Retyped #3
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | theme | baseline                    | threshold |
  | desktop  | dark  | marks-retyped-desktop-dark  | 98        |
  | phone    | dark  | marks-retyped-phone-dark    | 98        |
  | desktop  | light | marks-retyped-desktop-light | 98        |
  | phone    | light | marks-retyped-phone-light   | 98        |

Scenario Outline: Step log marks report surfaced false alarms and routine misses within Key and log limits
  Given a surfacing marks ledger is available in the <theme> theme
  And message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I open the surfacing step log
  Then the step log disables Raise at Key and Lower for a routine message
  When I Raise surfaced message #1 from the step log
  And I save the mark without a reason
  Then message #1 has an absolute key raise mark with no reason
  When I Lower surfaced message #2 from the step log
  And I save the mark with free text already covered in the final reply
  Then message #2 has an absolute balanced lower mark with reason already covered in the final reply
  When I Raise surfaced message #6 from the step log
  And I save the mark without a reason
  Then message #6 has an absolute all raise mark with no reason
  And the surfacing pins are 1,2,3,4,5,6,8 and level counts are Key 3, Balanced 5, All 7

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | dark  |
  | desktop  | light |
  | phone    | light |

Scenario Outline: Mark shortcuts cancel without writing and return focus to the card
  Given a surfacing marks ledger is available in the <theme> theme
  And message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  Then mark shortcuts open Why and Escape cancels without saving

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | dark  |
  | desktop  | light |
  | phone    | light |

Scenario Outline: Undo expires after six seconds
  Given a surfacing marks ledger is available in the <theme> theme
  And message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  And the surfacing marks clock is paused
  When I Raise surfaced message #3 from the card
  And I save the mark without a reason
  Then message #3 has an absolute balanced raise mark with no reason
  And the mark Undo stays available for six seconds

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | dark  |
  | desktop  | light |
  | phone    | light |

Scenario Outline: A remote clear after save acknowledgement removes the local mark without resurrecting it
  Given a surfacing marks ledger is available in the <theme> theme
  And message surfacing is active at All
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I Raise surfaced message #3 from the card
  And I save the mark without a reason
  Then message #3 has an absolute balanced raise mark with no reason
  And the surfacing mark toast says ▲ Raised #3 to Balanced
  When another device clears surfacing mark #3
  Then the selected message #3 has no mark label or pressed Raise
  When I set the surfacing level to Balanced
  And I pick surfaced message #1
  Then the surfacing pins are 1,2,4,5,8 and level counts are Key 3, Balanced 5, All 6

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | dark  |
  | desktop  | light |
  | phone    | light |
