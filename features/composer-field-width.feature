Feature: Phone composer gives a wrapping field the full width

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And I open a composer session
  And the mock relay lists a single agent

Scenario Outline: idle empty composer fits in one row
  Then the composer has 1 row
  And the composer placeholder is fully visible
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                  | threshold |
  | composer-field-idle-phone | 98        |

Scenario Outline: placeholders are never cut off in idle or working states
  When the mock relay sets composer status to <status>
  And the composer placeholder changes to <placeholder>
  Then the composer placeholder is fully visible
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | status     | placeholder                                                                        | baseline                            | threshold |
  | idle       | Ask Claude…                                                                        | composer-field-placeholder-phone    | 98        |
  | processing | Reply to steer…                                                                    | composer-field-working-empty-phone  | 98        |
  | idle       | Ask anything. / to use skills, @ to mention files, including a very long file path. | composer-field-long-placeholder-phone | 98      |
  | idle       | Message to un-settle…                                                              | composer-field-settled-phone        | 98        |
  | idle       | Message to wake…                                                                   | composer-field-snoozed-phone        | 98        |

Scenario Outline: typed text gets the full width as soon as it wraps
  When I type <message> into the composer
  Then the composer has 2 rows
  And the composer field is at least the composer width minus 20 pixels
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | message                                               | baseline                    | threshold |
  | Also run the Linux baselines before you call it done.  | composer-field-typing-phone | 98        |

Scenario Outline: deleting back to short text returns to one row
  When I type Also run the Linux baselines before you call it done. into the composer
  Then the composer has 2 rows
  When I type <message> into the composer
  Then the composer has 1 row
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | message | baseline                   | threshold |
  | Hi      | composer-field-short-phone | 98        |

Scenario Outline: send and stop do not squeeze text while typing
  When I type <message> into the composer
  And the mock relay sets composer status to processing
  Then send and stop are both visible
  And the composer has 2 rows
  And the composer field is at least the composer width minus 20 pixels
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | message                                                         | baseline                      | threshold |
  | Skip the flaky one and look at the focus ring before calling it done. | composer-field-working-phone | 98        |
