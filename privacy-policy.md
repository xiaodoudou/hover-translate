# Privacy policy: Hover Translate

Last updated: 4 August 2026

The Chrome Web Store requires a privacy policy at a public URL. This file's address in the
repository serves that purpose.

## What is sent, and when

Nothing leaves your browser until you press the trigger key. There is no background scanning, no
telemetry, no analytics and no crash reporting.

When you hover a block of text and press the trigger key, the text of that one block is sent to the
translation provider you have chosen, so that it can be translated. Nothing else about the page is
sent: not the URL, not the page title, not any other part of the page, and no identifier of you or
your browser.

The text is sent to whichever of these you have enabled, in your chosen order:

| Provider | Endpoint | Their privacy policy |
| --- | --- | --- |
| Google | `translate-pa.googleapis.com`, `translate.googleapis.com` | https://policies.google.com/privacy |
| Tencent TranSmart | `transmart.qq.com` | https://privacy.qq.com |
| MyMemory | `api.mymemory.translated.net` | https://mymemory.translated.net/doc/privacy.php |

Once the text reaches a provider it is subject to that provider's own policy, which is linked above.
Note that MyMemory is a shared translation memory: text sent to it may be retained and reused in
their public corpus. It is last in the default order for that reason. You can remove any provider
from the list on the extension's settings page.

## What is stored

Two things, both local to your browser:

- **Your settings**, in Chrome's extension storage: target language, display mode, provider order,
  trigger key, notice position and the loading delay. These sync through your Chrome profile if you
  have Chrome Sync enabled, exactly like any other extension setting.
- **A short-lived cache** of recent translations, held in memory only so that repeating the same
  block does not send a second request. It is discarded when the page is closed.

## What is not done

- No personal data is collected.
- Nothing is sold or shared with anyone beyond the translation provider you selected.
- No advertising, profiling, tracking or fingerprinting.
- No account, no login, no server operated by this extension.
- Browsing history is never read, recorded or transmitted.

## Permissions

- `storage` holds your settings, nothing else.
- The four host permissions are the translation endpoints listed above, and are the only hosts the
  extension can contact.
- The content script runs on the pages you visit because translation happens in place on the page you
  are reading. It stays inert until you press the trigger key.

## Contact

Questions about this policy can be raised on the extension's support page in the Chrome Web Store.
