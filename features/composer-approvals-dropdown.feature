Feature: Composer approvals dropdown sets the session permission mode

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: selecting an approvals option updates the pill
  When I set approvals to <mode>
  Then the approvals pill shows <label>

Examples:
  | mode        | label       |
  | full        | Full access |
  | acceptEdits | Edits       |
  | ask         | Ask         |

# The connected mockup binds the "anthropic" provider, which runs through
# OpenCode. Auto delegates to the Claude Agent SDK's own model classifier, so
# it is only offered on Claude sessions — offering it here would be a control
# that silently does nothing. Auto's positive path is covered in
# test/e2e/specs/permission-mode-selector.spec.ts, which can bind a Claude
# session directly.
Scenario: Auto is not offered on a session the classifier cannot serve
  Then the approvals dropdown does not offer auto

Scenario Outline: an auto-approving session is visibly flagged
  When I set approvals to <mode>
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | mode | baseline                    | threshold |
  | full | composer-approvals-full-dark | 98        |
