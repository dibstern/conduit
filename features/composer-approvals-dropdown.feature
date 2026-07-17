
Feature: Composer approvals dropdown sets the session permission mode

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: selecting an approvals option updates the pill
  When I set approvals to <mode>
  Then the approvals pill shows <label>

Examples:
  | mode        | label |
  | auto        | All   |
  | acceptEdits | Edits |
  | ask         | Ask   |

Scenario Outline: an auto-approving session is visibly flagged
  When I set approvals to <mode>
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | mode | baseline                    | threshold |
  | auto | composer-approvals-all-dark | 98        |
