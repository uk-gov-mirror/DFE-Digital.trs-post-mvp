# Design review (production build)

Chrome extension: pins and threaded comments on pages, with optional **Supabase** sync for shared reviews.

This folder is a **store-ready** build (separate from the `design-review-revamped` prototype). It includes a **Profile** (name and email) stored only in the browser, so a future version can add notifications without shipping credentials in the extension.

## What users do

1. After install, open the extension and use **Profile** (gear icon) to set **name** and **email**. Comments are attributed to that name. Email is not sent to a server unless you add that in a later release.
2. **Optional team sync:** create a Supabase project, run `supabase-schema.sql`, and put the Project URL and anon key in `config.js` (see `config.example.js`). Re-package or rebuild the extension for distribution.

## Package for the Chrome Web Store

1. Ensure `config.js` contains your Supabase `url` and `anonKey` (or leave them empty for local-only use). **Do not** publish a build with a key you are unwilling to treat as a client-side public key. Rotate the key in Supabase if it leaks.
2. Zip **this entire folder** (the one that includes `manifest.json` at the top level). The manifest must be at the root of the zip.
3. In the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), create an item, upload the zip, and complete the listing.

### Listing checklist (typical)

- **Single purpose:** design feedback on web pages the user visits.
- **Host permission `<all_urls>`:** explain that the extension must run on pages the user reviews (internal tools, staging sites, and so on). Narrowing the permission in `manifest.json` is an option if you only ever load specific origins.
- **Privacy policy URL:** you must link a policy that states what the extension does (e.g. comment data in `chrome.storage.local`, optional Supabase project URL, display name, email in local storage, no sale of personal data, etc.).

## Profile data (name and email)

- Stored in **`chrome.storage.local`** on the user’s device only.
- Shown in the UI for attribution (“Commenting as …”).
- **Not** written into Supabase in this version (only the comment `author` string is). A future **notifications** feature could use the stored email with your backend, subject to user consent and policy updates.

## Security notes

- The sample RLS in `supabase-schema.sql` allows broad access to `design_review_pages` for anyone with the anon key. Tighten policies (auth, workspace id, and so on) before wide deployment.
- Email and name are PII. Treat the privacy policy and in-product copy accordingly.

## Development

- Load unpacked: `chrome://extensions` → Developer mode → **Load unpacked** → select `extensions/design-review-prod`.
- After code changes, use **Reload** on the extension card.

## Differences from `design-review-revamped`

- Version and listing-oriented manifest text.
- `config.js` default has empty Supabase fields (use `config.example.js` as a template).
- User **Profile** in the comment panel: name, email, save, and clear. Banner prompt until both are set.
