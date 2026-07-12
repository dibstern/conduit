
Feature: Composer send button reflects input content

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: send button enables only when the composer has text
  When I type <message> into the composer
  Then the send button is <enabled>

Examples:
  | message     | enabled |
  | hello world | true    |
  | fix the bug | true    |
  |             | false   |

Scenario Outline: the composer matches the approved layout
  When I type <message> into the composer
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | message     | baseline                | threshold |
  | hello world | composer-with-text-dark | 98        |
