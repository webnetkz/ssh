# Privacy Scanner (Chrome Extension)

This extension scans the current page and shows:

- tracker count;
- which companies are tracking the user (for example, Google, Meta Platforms);
- privacy score: `🟢 Good`, `🟡 Medium`, `🔴 Bad`.

Included features:

- tracker blocking;
- fingerprint protection (basic canvas/webgl/audio masking);
- cookie warnings.

## Installation

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this project folder.

## Structure

- `manifest.json` - extension configuration.
- `src/background.js` - request analysis, score calculation, settings handling.
- `src/content/fingerprint.js` - fingerprint protection injected at page start.
- `src/popup/` - popup UI.
- `src/rules/tracker-blocklist.json` - blocking rules for known trackers.
