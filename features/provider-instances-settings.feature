
Feature: Named provider instances are managed in Settings and drive the composer rail

Background:
  Given the conduit app is served with the connected mockup

Scenario: the Server card shows daemon-wide status
  When I open settings to the Server section
  Then the Server card shows uptime, version, port and connected browsers

Scenario Outline: Shut down explains how the daemon starts again
  Given the daemon is <supervision>
  When I open settings to the Server section
  Then Server Restart is <restart>
  When I open the Server Shut down confirmation
  Then the Server Shut down warning says <warning>
  When I cancel the Server Shut down confirmation

Examples:
  | supervision  | restart | warning                                                                                |
  | supervised   | visible | Every browser disconnects. The login service will start it straight back.               |
  | unsupervised | hidden  | Every browser disconnects. Start it again from the terminal with conduit serve.          |

Scenario: opening Shut down closes the instance editor
  When I open settings to the Server section
  And I start adding a Claude instance
  And I open the Server Shut down confirmation
  Then the Server instance editor is closed
  When I cancel the Server Shut down confirmation

Scenario Outline: adding a named instance makes it selectable in the composer rail
  When I open settings to the Server section
  And I add a <driver> instance named <name>
  And I open the model picker
  Then the <name> instance is selectable in the picker

Examples:
  | driver   | name        |
  | OpenCode | Staging OC  |
  | Claude   | Work Claude |

Scenario: editing a named instance updates it in the settings list
  Given a named OpenCode instance Staging OC is already configured
  When I open settings to the Server section
  And I rename the Staging OC instance to Prod OC via edit
  Then the Instances list shows Prod OC
  And the Instances list does not show Staging OC

Scenario Outline: make an account default
  Given no provider accounts are configured
  And the default Claude account is named Claude with folder /profiles/original
  And a named Claude instance Personal is already configured
  When I open settings to the Server section
  And I make the Personal account default
  Then only the Personal Claude account has the default marker
  And SetDefault saves Personal as the default account
  And the instances-settings region visually matches provider-instances-settings-personal-default at <threshold> percent

Examples:
  | threshold |
  | 98        |

Scenario Outline: a new draft's composer shows the default account
  Given no provider accounts are configured
  And the default Claude account is named Claude with folder /profiles/original
  And a named Claude instance Personal is already configured
  And new drafts use a Claude model
  When I open settings to the Server section
  And I make the Personal account default
  And I close settings
  And I start a new session
  Then the draft composer and usage meter use the Personal account
  When I open the model picker
  Then the picker selects the Personal account
  And the model-picker region visually matches provider-instances-default-draft at <threshold> percent
  When I close the model picker
  And I type use my default account into the composer
  And I send the composer message
  Then the new session is created on the Personal account

Examples:
  | threshold |
  | 98        |

Scenario: moving the default makes the former built-in an ordinary picker account
  Given the configured Claude accounts are Claude and Personal with default Personal
  And new drafts use a Claude model
  When I start a new session
  Then the draft composer and usage meter use the Personal account
  When I open the model picker
  Then the picker selects the Personal account
  And the picker account names are Personal, Claude
  When I close the model picker
  And the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner is not visible
  When the relay disconnects and reconnect attempts are held
  Then the connect overlay offers no OpenCode instance actions

Scenario: no built-in account is manufactured from a cached Claude catalogue
  Given the configured Claude accounts are Personal with default Personal
  And new drafts use a Claude model
  When I start a new session
  Then the draft composer uses the Personal account and the usage meter shows only it
  When I open the model picker
  Then the picker uses Personal for the Claude harness
  And no former built-in Claude account is displayed
  When I close the model picker
  And I open settings to the Server section
  Then the Instances list shows Personal
  And the Instances list does not show Claude

Scenario: zero Claude accounts stays empty despite a cached Claude catalogue
  Given the configured Claude accounts are none with default none
  And new drafts use a Claude model
  When I start a new session
  And I open the model picker
  Then the picker account names are none
  And no former built-in Claude account is displayed
  When I close the model picker
  And I type Keep my draft until I add an account into the composer
  And I send the composer message
  Then an error toast contains Add a Claude account in Settings before sending
  And the composer still contains Keep my draft until I add an account
  And no session is created without an account
  When I open the model picker
  And I select the surviving OpenCode harness
  Then the draft composer selects the OpenCode account
  When I close the model picker
  And I send the composer message
  Then the new session is created on the OpenCode account
  When I open settings to the Server section
  Then the Instances list does not show Claude

Scenario: deleted-account history follows the server's effective account when the default changes
  Given the configured Claude accounts are Claude and Personal with default Personal
  And new drafts use a Claude model
  And a deleted-account session is published on Personal
  When I view the deleted-account session
  Then the session composer and usage meter use the Personal account
  When the session hits the five_hour limit on deleted-account resetting at none
  Then the session's usage limit names Personal
  When the mock relay reports OpenCode reconnecting
  Then the OpenCode connection banner is not visible
  When the deleted-account session is published on Claude after a default change
  Then the session composer and usage meter use the Claude account
  And the session's usage limit names Claude
  And the OpenCode connection banner is not visible
  When I open the model picker
  Then the picker selects the Claude account

Scenario: the default Claude account shares the editor and cannot be removed
  Given the default Claude account is named Personal Claude with folder /profiles/personal
  When I open settings to the Server section
  And I edit the default Claude account
  Then the default Claude editor shows name Personal Claude and folder /profiles/personal
  And the default Claude account cannot be removed
  When I save the default Claude account as Home Claude with folder /profiles/home
  Then the Instances list shows Home Claude
  And the default Claude account shows folder /profiles/home with Applies after restart
  And UpdateInstance saves the default Claude name Home Claude and folder /profiles/home

Scenario: the default Claude account can return to the environment's login
  Given the default Claude account is named Personal Claude with folder /profiles/personal
  When I open settings to the Server section
  And I edit the default Claude account
  And I save the default Claude account as Personal Claude with folder empty
  Then the default Claude account shows folder env with Applies after restart
  And UpdateInstance saves the default Claude name Personal Claude and folder empty

Scenario: the OpenCode empty state includes setup guides even with a Claude account
  Given no OpenCode servers are configured and CCS is detected
  When I open settings to the Server section
  Then the OpenCode empty state offers the serve command and Scan link
  And the OpenCode setup guides are collapsed with the CCS tick

Scenario: the Add form switches between managed and external OpenCode servers
  When I open settings to the Server section
  And I start adding an OpenCode instance
  Then the OpenCode editor offers name and port with environment variables collapsed
  When I expand the instance environment variables
  Then the instance environment field is visible
  When I turn off Conduit starts it
  Then the OpenCode editor offers name and URL

Scenario: removing a named instance drops it from the settings list
  Given a named OpenCode instance Staging OC is already configured
  When I open settings to the Server section
  And I remove the Staging OC instance
  Then the Instances list does not show Staging OC

Scenario Outline: the instance editor matches the approved layout
  Given no provider accounts are configured
  When I open settings to the Server section
  And I start adding a <driver> instance
  Then the instances-settings region visually matches <baseline> at <threshold> percent

Examples:
  | driver | baseline                         | threshold |
  | Claude | provider-instances-settings-dark | 98        |

Scenario: Usage owns the limit settings beside the Claude and Server sections
  When I open settings to the Server section
  Then the Server section has no usage limit settings
  And the settings sections place Usage and Server under This computer
