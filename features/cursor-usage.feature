Feature: Cursor monthly usage uses an explicitly enabled credential

Scenario Outline: Cursor account tiles count configured accounts even when one is unavailable
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And Cursor plan usage is can_enable
  When I open settings to the Usage section
  Then the Cursor Usage account cursor-work shows its logo without a letter badge
  Given a second Cursor usage account is configured but unavailable
  Then the Cursor Usage account cursor-work shows its logo with a letter badge
  And the Cursor Usage account cursor-personal shows its logo with a letter badge
  And the Cursor Usage account names are left aligned

Examples:
  | tier  |
  | wide  |
  | phone |

Scenario Outline: a Cursor reading appears in the existing Month footer
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And Cursor plan usage is keychain
  Then the Cursor Month footer shows 38 percent
  And the <footer_region> region visually matches cursor-usage-footer at <threshold> percent

Examples:
  | tier  | footer_region      | threshold |
  | wide  | sidebar            | 98        |
  | phone | usage-footer-phone | 98        |

Scenario Outline: enable and disable Keychain usage for this account
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And Cursor plan usage is can_enable
  When I open settings to the Usage section
  Then the Cursor usage card offers Enable with the Keychain explanation
  And the cursor-usage-settings region visually matches cursor-usage-can-enable at <threshold> percent
  When I enable Cursor Keychain usage
  Then the Cursor usage card shows Month 38 percent and a reset date with Disable
  And the cursor-usage-settings region visually matches cursor-usage-keychain at <threshold> percent
  When I disable Cursor Keychain usage
  Then the Cursor usage card offers Enable with the Keychain explanation
  And the cursor-usage-settings region visually matches cursor-usage-disabled at <threshold> percent

Examples:
  | tier  | threshold |
  | wide  | 98        |
  | phone | 98        |

Scenario Outline: an unavailable dashboard reading shows its reason
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And Cursor plan usage is unavailable
  When I open settings to the Usage section
  Then the Cursor usage card reports Cursor usage is unavailable. Try again later.
  And the cursor-usage-settings region visually matches cursor-usage-unavailable at <threshold> percent

Examples:
  | tier  | threshold |
  | wide  | 98        |
  | phone | 98        |

Scenario Outline: a failed Enable stays inline and can be retried
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And Cursor plan usage is can_enable
  And Cursor Keychain Enable will fail with Keychain access was denied. Try again and allow access.
  When I open settings to the Usage section
  And I enable Cursor Keychain usage
  Then the Cursor usage card reports Keychain access was denied. Try again and allow access.
  And the cursor-usage-settings region visually matches cursor-usage-enable-error at <threshold> percent

Examples:
  | tier  | threshold |
  | wide  | 98        |
  | phone | 98        |
