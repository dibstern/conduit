Feature: A session in another project that needs you toasts where you are, and Open goes there

# conduit-test-82tn.11. You are in Atlas. A Beacon session starts asking for
# approval or asks a question. The daemon shell carries every project's rows,
# so the arrival toast shows in Atlas, on desktop and phone. As in t3code, the
# ask is answered in the asking session: Open goes there and attaches Beacon,
# whose approvals feed then shows the card.

Scenario Outline: A Beacon session waiting on <need> toasts in Atlas on a <viewport>, and Open goes there
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has the project tree fixture
  And opening a session attaches the session's own project
  When Beacon session 1 starts waiting on <need>
  Then an arrival toast says Beacon session 1 <says>
  When I tap Open on the arrival toast
  Then Beacon session 1 is open, attached to the beacon project

Examples:
  | viewport | need     | says           |
  | desktop  | approval | needs approval |
  | phone    | approval | needs approval |
  | desktop  | a reply  | has a question |
  | phone    | a reply  | has a question |
