
Feature: Named provider instances are managed in Settings and drive the composer rail

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: adding a named instance makes it selectable in the composer rail
  When I open settings to the Instances tab
  And I add a <driver> instance named <name>
  And I open the model picker
  Then the <name> instance is selectable in the rail

Examples:
  | driver   | name        |
  | OpenCode | Staging OC  |
  | Claude   | Work Claude |

Scenario Outline: the instance editor matches the approved layout
  When I open settings to the Instances tab
  And I start adding a Claude instance
  Then the instances-settings region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                         | threshold |
  | provider-instances-settings-dark | 98        |
