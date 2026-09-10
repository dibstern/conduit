
Feature: Agent list follows the selected harness

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: the agent selector shows only the selected harness agents
  When I select the <harness> harness
  Then the agent selector lists <agents>
  And the agent selector does not list <hiddenAgents>

Examples:
  | harness  | agents           | hiddenAgents    |
  | Claude   | planner,reviewer | opencode-triage |
  | OpenCode | opencode-triage  | planner         |

Scenario Outline: switching harness re-scopes the agent list
  When I select the <first> harness
  And I select the <second> harness
  Then the agent selector label shows <second> agents

Examples:
  | first  | second   |
  | Claude | OpenCode |

Scenario Outline: the agent selector matches the approved layout for a harness
  When I select the <harness> harness
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | harness | baseline                   | threshold |
  | Claude  | agent-selector-claude-dark | 98        |
