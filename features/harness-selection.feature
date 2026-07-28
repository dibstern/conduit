
Feature: Harness/instance is selected via the model-picker rail and fixed at creation

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: selecting a rail instance sets the harness for a new session
  When I open the model picker
  And I select the <instance> instance in the rail
  And I type <message> into the composer
  And I send the composer message
  Then a session is created on the <harness> harness

Examples:
  | instance         | harness  | message       |
  | Claude           | Claude   | plan the work |
  | OpenCode · Local | OpenCode | fix the bug   |

Scenario Outline: the composer trigger shows the bound instance icon
  Given a session already exists on the <harness> harness
  Then the model trigger shows the <harness> instance icon

Examples:
  | harness  |
  | Claude   |
  | OpenCode |

Scenario Outline: the rail is locked once a session exists
  Given a session already exists on the <harness> harness
  When I open the model picker
  Then the <harness> instance in the rail is selected
  And instances of other harnesses in the rail are disabled

Examples:
  | harness  |
  | Claude   |
  | OpenCode |

Scenario Outline: the model picker matches the approved layout
  When I open the model picker
  And I select the <instance> instance in the rail
  Then the model-picker region visually matches <baseline> at <threshold> percent

Examples:
  | instance | baseline                      | threshold |
  | Claude   | model-picker-rail-claude-dark | 98        |
