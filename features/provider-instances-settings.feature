
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

Scenario: editing a named instance updates it in the settings list
  Given a named OpenCode instance Staging OC is already configured
  When I open settings to the Instances tab
  And I rename the Staging OC instance to Prod OC via edit
  Then the Instances list shows Prod OC
  And the Instances list does not show Staging OC

Scenario: removing a named instance drops it from the settings list
  Given a named OpenCode instance Staging OC is already configured
  When I open settings to the Instances tab
  And I remove the Staging OC instance
  Then the Instances list does not show Staging OC

Scenario Outline: the instance editor matches the approved layout
  When I open settings to the Instances tab
  And I start adding a Claude instance
  Then the instances-settings region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                         | threshold |
  | provider-instances-settings-dark | 98        |

Scenario Outline: the usage limit setting matches frame H and saves auto-resume
  Given the viewport is a <viewport>
  And auto-resume limited sessions is off on the daemon
  When I open settings to the Instances tab
  Then the usage limit settings heading reads <heading>
  And the Auto-resume limited sessions toggle is off and reads <description>
  When I turn on Auto-resume limited sessions
  Then the SetUsageLimitsSetting RPC turns auto-resume on
  And the Auto-resume limited sessions toggle is on and reads <description>
  And the usage-limit-settings region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | heading                                        | description                                                              | baseline                      | threshold |
  | desktop  | When a Claude account reaches its usage limit | Continue the cut-off request on the same account when its limit resets. | usage-limit-settings-desktop  | 98        |
  | phone    | Usage limits                                   | Same account, at reset.                                                  | usage-limit-settings-phone    | 98        |

Scenario Outline: auto-switch and its account order match frame H and save the order
  Given the viewport is a <viewport>
  And the Claude accounts are claude as work2claude, self as personal, team as team-max
  And the daemon's usage limits are auto-resume on, auto-switch off, order team, claude
  And the quota check reads claude limited until 2026-01-05T09:00:00Z, self 38% used, team unknown
  When I open settings to the Instances tab
  Then the Auto-switch account toggle is off and reads <description>
  And the account order reads team-max, work2claude, personal
  And the account work2claude shows limited · Mon 9:00 quota
  And the account personal shows 62% left quota
  And the account team-max shows quota unknown quota
  And the usage-limit-settings region visually matches <baseline> at <threshold> percent
  When I turn on Auto-switch account
  Then the SetUsageLimitsSetting RPC saves auto-resume on, auto-switch on, order team, claude
  When I move personal to the top of the account order by <input>
  Then the account order reads personal, team-max, work2claude
  And the SetUsageLimitsSetting RPC saves auto-resume on, auto-switch on, order self, team, claude
  And the account order announces Dropped personal at position 1 of 3.

Examples:
  | viewport | description                                                                          | input    | baseline                         | threshold |
  | desktop  | Move the session to the first account below that has quota. Runs before auto-resume. | keyboard | usage-limit-auto-switch-desktop  | 98        |
  | phone    | First account with quota.                                                            | touch    | usage-limit-auto-switch-phone    | 98        |
