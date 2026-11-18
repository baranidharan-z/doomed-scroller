# Doomed Scroller

A browser extension that notices when you're doomscrolling, warns you, and
eventually stops you.

It doesn't just time how long a site is open. It measures **active time and
how far you've scrolled**, so an hour watching one long video or reading one
article doesn't count, but twenty minutes flicking through a feed does.

Works on **YouTube, Reddit and LinkedIn**, in Brave, Chrome, Edge and other
Chromium-based browsers.

## How it works

1. **Measures.** On each supported site it counts:
   - **Active time:** the tab is visible and focused, and you've scrolled,
     typed or moved the mouse in the last 60 seconds.
   - **Screens scrolled:** total scroll distance divided by window height.
2. **Warns.** When a site reaches **both** limits for the day (default:
   15 min **and** 30 screens), a full-screen overlay appears and pauses any
   video. You can close the tab or take **5 more minutes**.
3. **Extends.** Each extension raises both limits (default: +5 min, +10
   screens).
4. **Blocks.** Hit the limit again after using all extensions (default: 3) and
   the site is blocked until midnight.

Counts are per site and reset every day at local midnight.

## Install

There's no store listing yet. You install it from the source folder.

1. **Get the code**
   - `git clone https://github.com/baranidharan-z/doomed-scroller.git`, or
   - on GitHub, click **Code → Download ZIP** and extract it.
2. **Open your browser's extensions page**
   - Brave: `brave://extensions`
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Turn on **Developer mode** (a toggle, usually top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin the extension to the toolbar to see your daily stats.

Keep the folder where it is: the browser loads the extension from it each time.
To update, pull or re-download, then click the reload icon on the extension's
card.

Firefox and Safari aren't supported.

## Using it

- **Toolbar popup:** today's time, screens and extensions per site, with the
  current status (ok / warn / blocked).
- **Settings** (link in the popup, or right-click the icon → Options): change
  the limits.

### Limit changes take 2 hours to apply

On purpose. When you're mid-scroll and want "just 10 more minutes", raising
the limit right then doesn't help: the new limits only take effect 2 hours
after you save them. Until then the old ones stay in force and the settings
page shows a countdown. Saving again restarts the 2 hours. Cancelling a pending
change takes effect immediately.

## Privacy

- **Everything stays on your device.** Usage is saved in the browser's local
  extension storage. Nothing is sent anywhere, and there's no server, analytics
  or account.
- **Minimal permissions.** It only asks for `storage`, and its script runs only
  on `youtube.com`, `reddit.com` and `linkedin.com`.
- **No content is read.** It records time and scroll distance, not what you
  look at.
- **History:** 30 days of daily totals are kept, then deleted.

## Configuration

Code-level defaults live in `CONFIG` at the top of [`shared.js`](shared.js):

| Key | Default | Meaning |
|---|---|---|
| `baseMinutes` / `baseScreens` | 15 / 30 | Warn when both are reached |
| `extendMinutes` / `extendScreens` | 5 / 10 | Added per extension |
| `maxExtensions` | 3 | Extensions before the site is blocked |
| `idleMs` | 60 000 | Stop counting time after this long with no input |
| `coolOffMs` | 2 h | Delay before new limits apply |
| `retainDays` | 30 | Days of history kept |
| `uninstallUrl` | empty | Page the browser opens after the extension is removed |

Once you've saved limits from the Settings page, those saved values are used
instead of the code defaults.

**Uninstall page (optional).** [`uninstall-page/index.html`](uninstall-page/index.html)
is a short "was that the urge talking?" page. Browsers only open an `http(s)`
address after removal, so host the file somewhere (GitHub Pages works) and put
the address in `uninstallUrl`.

## Limitations

This is a speed bump, not a lock. Anyone who can install it can also:

- turn it off or remove it on the extensions page,
- use a private window, guest window or another browser profile (extensions
  don't run there by default),
- use a different browser,
- edit `shared.js`.

A harder lock is possible: install it through browser policies (managed
install, no private or guest windows) and use a non-admin account day to day.
That isn't set up here.

Measurement on some layouts is untested. In particular, **YouTube Shorts** may
not report scroll distance. Issues and fixes are welcome.

## Development

No build step and no dependencies. It's plain JavaScript and a Manifest V3
extension.

```
manifest.json        extension manifest
shared.js            config + pure rules (warn/extend/block, settings cool-off)
background.js        service worker: the only code that writes to storage
content.js           runs on the sites: measures time/scroll, shows the overlay
popup.html/.js       toolbar popup with today's stats
options.html/.js     settings page
uninstall-page/      optional page to host for after-uninstall
test/                node:test unit tests
```

Run the tests (Node 22+):

```sh
npm test
```

After changing code, click reload on the extension card **and reload any open
site tabs**. Tabs left open keep running the old script, which stops tracking.

Design notes:
- **One writer.** Content scripts send totals to the background, and only the
  background writes to storage, one update at a time. Two open tabs on the same
  site therefore can't overwrite each other's counts.
- **Testable rules.** The rules in `shared.js` are pure functions with no
  browser APIs, so Node can test them directly.
- **No HTML strings.** The overlay is built element by element because YouTube
  rejects HTML assigned via `innerHTML` (Trusted Types).

### Adding a site

1. Add it to `SITES` in `shared.js`.
2. Add its URL pattern to `content_scripts.matches` in `manifest.json`.
3. Reload the extension.

## Roadmap

- Sites configurable from the settings page
- Weekly history chart
- Escalating friction (toast, then blur, then block)
- Smarter detection (scroll speed, long stretches with no clicks)
- Store listing

## License

[MIT](LICENSE)
