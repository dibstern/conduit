Feature: Composer picker keeps harness, model, context and effort choices together

Scenario Outline: C1 draft Claude accounts form a grid and bind the project on tap
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the configured Harness choices are Claude, OpenCode
  And the Claude accounts are claude as personal, self as work
  And the quota check reads claude 62% used, self 90% used
  And I start a new session
  And the composer picker has the Claude catalog
  When I view Account choices in the picker
  Then the Account section has 2 equal-width cards and the caption 5-hour use
  And the picker root sections and rows are harness, account, model, context, effort, agent
  And the picker card claude is named personal and shows its AccountDot
  And the claude Account card shows 62% usage
  And the self Account card shows 90% usage
  And the claude Account card is selected and in view
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I select the self Account card
  Then the self Account card is selected and in view
  And the draft is bound to the self instance
  When I close the model picker
  And the quota check reads claude 40% used, self 23% used
  And I open the model picker
  Then the claude Account card shows 40% usage
  And the self Account card shows 23% usage
  And the picker has refreshed account quotas 2 times

Examples:
  | tier  | baseline                   | threshold |
  | wide  | composer-picker-account-c1 | 98        |
  | phone | composer-picker-account-c1 | 98        |

Scenario Outline: C2 limited cards are inert and unknown usage can be selected in a draft
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the configured Harness choices are Claude, OpenCode
  And the Claude accounts are claude as personal, self as work, client as client
  And the quota check reads claude 62% used, self limited until 2026-01-01T14:30:00Z, client <reading>
  And I start a new session
  And the composer picker has the Claude catalog
  When I view Account choices in the picker
  Then the Account section has 3 equal-width cards and the caption 5-hour use
  And the self Account card is limited until 2026-01-01T14:30:00Z
  And the client Account card shows unknown usage
  And the claude Account card is selected and in view
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I try to pick the self Account card
  Then the claude Account card is selected and in view
  And the card tap sends no binding or handoff RPC
  When I select the client Account card
  Then the client Account card is selected and in view
  And the draft is bound to the client instance

Examples:
  | tier  | reading     | baseline                   | threshold |
  | wide  | unknown     | composer-picker-account-c2 | 98        |
  | phone | unavailable | composer-picker-account-c2 | 98        |

Scenario Outline: C3 five accounts scroll, fade, reveal the selection and support arrow keys
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the configured Harness choices are Claude, OpenCode
  And the Claude accounts are claude as personal, self as work, client as client, research as research, ops as ops
  And the quota check reads claude 62% used, self 90% used, client 15% used, research unknown, ops 40% used
  And I start a new session
  And the composer picker has the Claude catalog
  When I view Account choices in the picker
  Then the Account section has 5 scroll-snap cards and the caption 5-hour use
  And the Account row has a right-edge fade
  And the claude Account card is selected and in view
  And the claude Account card shows 62% usage
  And the self Account card shows 90% usage
  And the research Account card shows unknown usage
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I scroll the Account row to the end
  Then the Account row has no right-edge fade
  When I select the ops Account card
  And I scroll the Account row to the start
  Then the ops Account card is outside the visible row
  When I close the model picker
  And I open the model picker
  Then the ops Account card is selected and in view
  And the Account row has no right-edge fade
  When I move to the previous Account card with the keyboard
  Then the research Account card is selected and in view
  And the draft is bound to the research instance
  When I move to the next Account card with the keyboard
  Then the ops Account card is selected and in view
  And the draft is bound to the ops instance

Examples:
  | tier  | baseline                   | threshold |
  | wide  | composer-picker-account-c3 | 98        |
  | phone | composer-picker-account-c3 | 98        |

Scenario Outline: C2 open Claude cards show quotas while account switching remains inert
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the harness logo is viewed in the <tier> tier
  And the Claude accounts are claude as personal, self as work, client as client
  And the quota check reads claude 62% used, self limited until 2026-01-01T14:30:00Z, client unknown
  And the composer picker has the Claude catalog
  When I view Account choices in the picker
  Then the claude Account card is selected and in view
  And the claude Account card is disabled
  And the claude Account card shows 62% usage
  And the self Account card is limited until 2026-01-01T14:30:00Z
  And the client Account card shows unknown usage
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I try to pick the claude Account card
  Then the card tap sends no binding or handoff RPC
  When I select the client Account card
  Then the claude Account card is selected and in view
  And the card tap sends no binding or handoff RPC

Examples:
  | tier  | baseline                        | threshold |
  | wide  | composer-picker-account-c2-open | 98        |
  | phone | composer-picker-account-c2-open | 98        |

Scenario Outline: C5 draft OpenCode instances show status cards and bind immediately
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the configured Harness choices are Claude, OpenCode
  And a named OpenCode instance Bedrock is already configured
  And the OpenCode instance bedrock has stopped status
  And I start a new session
  And the composer picker has the OpenCode catalog
  When I view Harness choices in the picker
  And I select the OpenCode Harness tab in the picker
  Then the Instance section has 2 equal-width cards and the caption status
  And the opencode Instance card shows healthy status
  And the bedrock Instance card shows stopped status
  And the picker card bedrock is named Bedrock and shows its AccountDot
  And the opencode Instance card is selected and in view
  When I select the bedrock Instance card
  Then the bedrock Instance card is selected and in view
  And the draft is bound to the bedrock instance
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | tier  | baseline                   | threshold |
  | wide  | composer-picker-account-c5 | 98        |
  | phone | composer-picker-account-c5 | 98        |

Scenario Outline: C5 OpenCode instance cards are locked in an open session
  Given the conduit app is served with the connected mockup
  And a session already exists on the OpenCode harness
  And the harness logo is viewed in the <tier> tier
  And a named OpenCode instance Bedrock is already configured
  And the OpenCode instance bedrock has <status> status
  And the composer picker has the OpenCode catalog
  When I view Instance choices in the picker
  Then the Instance section has 2 equal-width cards and the caption status
  And the opencode Instance card is selected and in view
  And the bedrock Instance card shows <status> status
  And the Instance cards are locked and announce Harness is fixed for this session
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I try to pick the bedrock Instance card
  Then the opencode Instance card is selected and in view
  And the card tap sends no binding or handoff RPC

Examples:
  | tier  | status    | baseline                          | threshold |
  | wide  | unhealthy | composer-picker-account-c5-locked | 98        |
  | phone | starting  | composer-picker-account-c5-starting | 98      |

Scenario Outline: C6 a single account or instance hides its section beneath two Harness tabs
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the configured Harness choices are Claude, OpenCode
  And I start a new session
  And the composer picker has the <harness> catalog
  When I view Harness choices in the picker
  And I select the <harness> Harness tab in the picker
  Then the picker has no Account or Instance section
  And the picker root sections and rows are <rows>
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | tier  | harness  | rows                                   | baseline                            | threshold |
  | wide  | Claude   | harness, model, context, effort, agent | composer-picker-account-c6-claude   | 98        |
  | phone | Claude   | harness, model, context, effort, agent | composer-picker-account-c6-claude   | 98        |
  | wide  | OpenCode | harness, model, context, agent         | composer-picker-account-c6-opencode | 98        |
  | phone | OpenCode | harness, model, context, agent         | composer-picker-account-c6-opencode | 98        |

Scenario Outline: C1 two harnesses are equal-width tabs in the picker root
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the configured Harness choices are Claude, OpenCode
  And I start a new session
  When I view Harness choices in the picker
  And I select the Claude Harness tab in the picker
  Then the Harness section has 2 equal-width segmented tabs
  And the Claude Harness tab is selected and in view
  And the picker subtitle is new session
  And the picker has no Harness drill-in
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I move to the next Harness with the keyboard
  Then the OpenCode Harness tab is selected and in view
  And the draft is bound to the opencode instance

Examples:
  | tier  | baseline                        | threshold |
  | wide  | composer-picker-harness-c1       | 98        |
  | phone | composer-picker-harness-c1       | 98        |

Scenario Outline: C4 five harnesses scroll with a fade and reveal the selected tab on open
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the configured Harness choices are Claude, OpenCode, Codex, Gemini, Cursor
  And I start a new session
  When I view Harness choices in the picker
  And I select the Claude Harness tab in the picker
  Then the Harness section has 5 scroll-snap tabs
  And the Claude Harness tab is selected and in view
  And the Harness row fades and cuts its last visible tab
  And the Codex, Gemini, Cursor Harness tabs have fallback logos
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I scroll the Harness row to the end
  Then the Harness row has no right-edge fade
  When I select the Gemini Harness tab in the picker
  And I scroll the Harness row to the start
  Then the Gemini Harness tab is outside the visible row
  When I close the model picker
  And I open the model picker
  Then the Gemini Harness tab is selected and in view
  And the Harness row has no right-edge fade
  And the draft is bound to the gemini instance

Examples:
  | tier  | baseline                        | threshold |
  | wide  | composer-picker-harness-c4       | 98        |
  | phone | composer-picker-harness-c4       | 98        |

Scenario Outline: C6 one configured harness hides the Harness section
  Given the conduit app is served with the connected mockup
  And the harness logo is viewed in the <tier> tier
  And the configured Harness choices are <harness>
  And I start a new session
  When I open the model picker
  Then the picker has no Harness section
  And the picker has no Account or Instance section
  And the picker has no Harness drill-in
  And the picker subtitle is new session
  And the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | tier  | harness  | baseline                          | threshold |
  | wide  | Claude   | composer-picker-harness-c6-claude  | 98        |
  | phone | Claude   | composer-picker-harness-c6-claude  | 98        |
  | wide  | OpenCode | composer-picker-harness-c6-opencode | 98       |
  | phone | OpenCode | composer-picker-harness-c6-opencode | 98       |

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
