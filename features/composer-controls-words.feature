Feature: Words composer controls keep model, context, effort and approvals below the field

Scenario Outline: phone Settings selects Words and reload keeps the preference
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the Composer tab
  And I choose Words for composer controls
  Then the composer words row shows Sonnet 5, 200K, DEF and ask
  And the composer icon controls are absent
  And the words row is below the composer border
  When I reload the Words composer
  Then the composer words row shows Sonnet 5, 200K, DEF and ask
  And the composer icon controls are absent
  And the words row is below the composer border
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                      | threshold |
  | composer-controls-words-phone | 98        |

Scenario Outline: phone effort word cycles on tap and opens the existing menu on hold
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the Composer tab
  And I choose Words for composer controls
  Then the effort word shows DEF
  When I tap the effort word
  Then the effort word shows low
  And the effort menu is closed
  When I tap the effort word
  Then the effort word shows med
  When I hold the effort word
  Then the effort menu lists Default and every offered level
  And the effort word shows med
  When I set effort to default
  Then the effort word shows DEF
  And the effort menu is closed
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                            | threshold |
  | composer-controls-words-effort-phone | 98        |

Scenario Outline: phone approvals word cycles on tap and opens the existing menu on hold
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
  Then the approvals word shows ask
  And the approvals menu is closed
  When I hold the approvals word
  Then the approvals menu is ranked dontAsk, plan, ask, acceptEdits, auto, full
  And the approvals word shows ask
  When I set approvals to acceptEdits
  Then the approvals word shows edits
  And the approvals word uses the edits tone
  And the approvals menu is closed
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                               | threshold |
  | composer-controls-words-approvals-phone | 98        |

Scenario Outline: phone model word opens the shared P2 bottom sheet
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  And approvals are ask
  When I open settings to the Composer tab
  And I choose Words for composer controls
  And I open the model picker
  Then the picker root shows Claude and Sonnet 5
  And the picker is a phone bottom sheet
  And the picker offers context windows 200k, 1m
  And the picker lists every effort level including xhigh
  When I close the model picker
  Then the composer words row shows Sonnet 5, 200K, DEF and ask
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
