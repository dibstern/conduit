Feature: Composer picker keeps harness, model, context and effort choices together

Scenario Outline: phone opens the root as a bottom sheet with context and every effort level
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open the model picker
  Then the picker root shows Claude and Sonnet 5
  And the picker is a phone bottom sheet
  And the picker offers context windows 200k, 1m
  And the picker context 200k is selected and the composer reflects 200K
  And the picker lists every effort level including xhigh
  And no effort segment in the picker is selected
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                   | threshold |
  | composer-picker-root-phone | 98        |

Scenario Outline: phone Model view lists model contexts and Back returns to the root
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I view Model choices in the picker
  Then the picker model Sonnet 5 lists context windows 200K, 1M
  And the picker model Opus 5 lists context windows 1M
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I go Back in the picker
  Then the picker root shows Claude and Sonnet 5

Examples:
  | baseline                     | threshold |
  | composer-picker-models-phone | 98        |

Scenario Outline: phone context selection stays open and survives closing and reopening
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open the model picker
  And I select context window 1m in the picker
  Then the picker context 1m is selected and the composer reflects 1M
  And the picker root shows Claude and Sonnet 5
  When I close the model picker
  And I open the model picker
  Then the picker context 1m is selected and the composer reflects 1M
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                         | threshold |
  | composer-picker-context-1m-phone | 98        |

Scenario Outline: phone OpenCode shows its single context window as a static value
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the OpenCode harness
  And the composer picker has the OpenCode catalog
  When I open the model picker
  Then the picker root shows OpenCode and Sonnet 4
  And the picker shows a static 200K context window
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                             | threshold |
  | composer-picker-context-static-phone | 98        |

Scenario Outline: phone xhigh selection stays open and Default leaves no effort segment selected
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open the model picker
  And I select effort xhigh in the picker
  Then the picker effort xhigh is selected while the root remains open
  And the effort meter shows XHIGH
  When I set effort to default
  Then the effort meter shows DEF
  When I open the model picker
  Then no effort segment in the picker is selected
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                             | threshold |
  | composer-picker-effort-default-phone | 98        |

Scenario Outline: selecting a model on a phone returns to the root with the sheet still open
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I view Model choices in the picker
  And I select model Opus 5 in the picker
  Then the picker root shows Claude and Opus 5
  And the picker is a phone bottom sheet
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                          | threshold |
  | composer-picker-model-chosen-phone | 98        |

Scenario Outline: desktop opens the same root rows in a popover
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open the model picker
  Then the picker root shows Claude and Sonnet 5
  And the picker is a desktop popover
  And the picker offers context windows 200k, 1m
  And the picker lists every effort level including xhigh
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | composer-picker-root-desktop | 98        |
