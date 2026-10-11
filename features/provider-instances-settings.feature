
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
  Then the <name> instance is selectable in the rail

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
