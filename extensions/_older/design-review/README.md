# Design review extension (local prototype)

Chrome extension that adds numbered pins, threaded comments, and a per-thread **resolved** state for the page you are on. Data is stored with `chrome.storage.local` in this browser only.

## Install (developer mode)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder: `extensions/design-review`.
4. After code changes, click **Reload** on the extension card.
5. Click the **puzzle piece** in the Chrome toolbar, find this extension, and click the **pin** so the blue icon stays visible (Chrome hides new extensions by default).

## Use

1. Open any website (including local prototypes).
2. Click the extension icon in the toolbar to open the **Comments on this page** panel (click again to close).
3. Click **Add pin to page**, then click the page where you want a pin. The crosshair turns off after one placement.
4. Use the **Review** floating button to turn placement mode on or off without opening the panel.
5. Click a numbered pin to open its thread. Use **Reply** under a comment for nested replies. Tick **Mark thread resolved** to grey out the pin and treat the thread as done.

## Limits (prototype)

- Comments are **not synced**; other people will not see them unless you use the Supabase variant in `extensions/design-review-revamped`.
- Pins use a generated CSS selector; if the DOM changes a lot, a pin may drift or fall back to the saved viewport position.
- Some restricted URLs (for example `chrome://`) cannot run content scripts.

## Next steps for sharing

Use `extensions/design-review-revamped` with a Supabase project, or add your own API plus auth and replace `chrome.storage.local` read/write with fetch and realtime updates.
