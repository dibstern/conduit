Feature: Composer highlights recognised skills inline

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: recognised skills render as pills and unknown tokens render as errors
  When I type <message> into the composer
  Then the composer region visually matches <baseline> at <threshold> percent

Examples:
  | message                      | baseline                 | threshold |
  | run /commit then /bogus done | composer-skill-pill-dark | 98        |
