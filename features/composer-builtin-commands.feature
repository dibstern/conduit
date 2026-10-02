Feature: Composer lists provider built-ins under $ and skills under /

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: each trigger lists only its own commands
  When I type <typed> into the composer
  Then the command menu offers <offered>
  And the command menu does not offer <hidden>

Examples:
  | typed | offered  | hidden   |
  | $     | $compact | $commit  |
  | /     | /commit  | /compact |

Scenario Outline: a built-in typed with $ reaches the provider as a slash command
  When I type <message> into the composer
  And I send the composer message
  Then the relay receives the sent text <sent>

Examples:
  | message       | sent          |
  | $compact now  | /compact now  |
  | costs $5 each | costs $5 each |
