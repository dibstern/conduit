Feature: Agent list follows the selected harness

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: the picker's agent view shows only the selected harness agents
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
  Then the agent selector lists <agents>
  And the agent selector does not list <hiddenAgents>

Examples:
  | first  | second   | agents          | hiddenAgents |
  | Claude | OpenCode | opencode-triage | planner      |
