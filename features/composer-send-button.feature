
Feature: Composer send button requires text and a model pick

Scenario Outline: send button enables only when the composer has text
  Given the conduit app is served with the connected mockup
  When I type <message> into the composer
  Then the send button is <enabled>

Examples:
  | message     | enabled |
  | hello world | true    |
  | fix the bug | true    |
  |             | false   |

Scenario Outline: the composer matches the approved layout
  Given the conduit app is served with the connected mockup
  When I type <message> into the composer
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | message     | baseline                | threshold |
  | hello world | composer-with-text-dark | 98        |

Scenario Outline: a draft without a harness default requires an explicit model pick
  Given the conduit app is served with the model-required mockup
  And the harness logo is viewed in the <tier> tier
  When I start a new session
  And I select the <harness> harness
  And I type Choose the model before sending into the composer
  Then the draft composer reads Select model
  And the send button is false
  When I view Model choices in the picker
  And I select model <model> in the picker
  And I close the model picker
  Then the draft composer holds model <model>
  And the send button is true

Examples:
  | tier  | harness  | model             |
  | wide  | Claude   | claude-sonnet-4-5 |
  | phone | Claude   | claude-sonnet-4-5 |
  | wide  | OpenCode | claude-sonnet-4   |
  | phone | OpenCode | claude-sonnet-4   |
