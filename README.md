# Doomed Scroller

A browser extension that notices when you're doomscrolling, warns you, and
eventually stops you.

It doesn't just time how long a site is open. It counts **active time**: only
while the tab is in front of you and you're actually using it.

Works on **YouTube, Reddit and LinkedIn**, in Brave, Chrome, Edge and other
Chromium-based browsers.

## How it works

1. **Measures.** On each supported site it counts active time: the tab is
   visible and focused, and you've scrolled, typed or moved the mouse in the
   last 60 seconds.
2. **Shows a live timer.** One full-width bar sits at the very top of the
   page, and the site starts below it: **DoomedScroller** on the left, **Time
   wasted today** in the middle (updating every second), and **Total time for
   youtube** on the right (the day's allowance, including extensions). It
   shows *paused* when time isn't being counted, and stays visible over
   fullscreen video.

   **From 75% of your time the bar grows,** smoothly, up to 35% of the window
   height at the limit, squeezing the site into less of the window. After you
   take an extension it stays at 35%. The time-wasted digits grow with it, a
   strip along the bottom shows how much of the allowance is used, and the bar
   takes on soft, low-glare colours:

   | Stage | When | Colour |
   |---|---|---|
   | Calm | 75% | soft teal |
   | Caution | 85% | warm sand |
   | Stop | 95%+, or after an extension | muted rose |
3. **Warns.** When a site reaches the day's limit (default: 15 min), a
   full-screen overlay appears and pauses any video. You can close the tab, or
   take **5 more minutes**, but that button stays locked for the first **2
   minutes** of the warning ("Come back in 1:59 to extend"), so extending is a
   decision rather than a reflex.
4. **Extends.** Each extension raises the limit (default: +5 min).
5. **Blocks.** Hit the limit again after using all extensions (default: 3) and
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

- **Timer bar** at the top of the site: time wasted today and total time allowed.
- **Toolbar popup:** minutes wasted, minutes left and extensions used per site,
  with the current status (ok / warn / blocked).
- **Settings** (link in the popup, or right-click the icon → Options): change
  the limits, and add sites to track.

### Limit changes take 2 hours to apply

On purpose. When you're mid-scroll and want "just 10 more minutes", raising
the limit right then doesn't help: the new limits only take effect 2 hours
after you save them. Until then the old ones stay in force and the settings
page shows a countdown. Saving again restarts the 2 hours. Cancelling a pending
change takes effect immediately.

### Adding sites

In Settings, type a site (like `instagram.com`) and click **Add site**. Your
browser asks you to allow access to that site; once you do, it's tracked like
the built-in ones. Reload any tabs of that site that were already open.

Sites **can't be removed from Settings**, on purpose: removing one is a
decision you make with a clear head, not mid-urge. To remove a site, add its
domain to `SITE_REMOVALS` in [`shared.js`](shared.js) and reload the
extension; its access is released too.

## Privacy

- **Everything stays on your device.** Usage is saved in the browser's local
  extension storage. The extension makes no network requests: no server, no
  analytics, no account.
- **Minimal permissions.** It asks for `storage`, and `scripting` to run its
  timer on sites you add. Its script runs on `youtube.com`, `reddit.com` and
  `linkedin.com`, plus only the sites you add yourself: access to each one is
  requested when you add it, and never before.
- **No content is read.** It records time only, not what you look at.
- **History:** 30 days of daily totals are kept, then deleted.

## Configuration

Code-level defaults live in `CONFIG` at the top of [`shared.js`](shared.js):

| Key | Default | Meaning |
|---|---|---|
| `baseMinutes` | 15 | Warn after this many active minutes per site per day |
| `extendMinutes` | 5 | Minutes added per extension |
| `maxExtensions` | 3 | Extensions before the site is blocked |
| `extendCooldownMs` | 2 min | How long "more minutes" stays locked after a warning |
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

To make room for the timer bar, the extension pushes the page down: it adds a
top margin to the page, makes the page the reference point for absolutely
positioned layouts (YouTube's whole app is one), and moves elements pinned to
the top of the window (like YouTube's top bar) below the bar. Side effects:

- A pinned element inside a site's web component may be missed and end up
  partly under the bar.
- A pop-up menu that a site positions in page coordinates may appear lower by
  the bar's height.

Issues and fixes are welcome.

## Development

No build step and no dependencies. It's plain JavaScript and a Manifest V3
extension.

```
manifest.json        extension manifest
shared.js            config + pure rules (warn/extend/block, settings cool-off)
background.js        service worker: the only code that writes to storage
content.js           runs on the sites: measures time, shows the timer bar and overlay
popup.html/.js       toolbar popup with today's stats
options.html/.js     settings page
icons/               extension icons (generated by tools/make_icons.py)
tools/make_icons.py  draws the icons with Pillow
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
- **No HTML strings.** The timer bar and overlay are built element by element
  because YouTube rejects HTML assigned via `innerHTML` (Trusted Types).
- **Fullscreen.** While an element is fullscreen the browser only draws that
  element, so the timer bar and overlay move inside it and move back on exit.
  youtube.com instead makes the whole page fullscreen, which keeps the bar's
  push-down; there the player area is shrunk to fit below the bar, so the
  video gets smaller (letterboxed) instead of being cut off at the bottom.

### Adding a built-in site

Most people should use **Add site** in Settings. To ship a site built in:

1. Add it to `SITES` in `shared.js`.
2. Add its URL pattern to `content_scripts.matches` in `manifest.json`.
3. Reload the extension.

## Roadmap

- Weekly history chart
- Escalating friction (toast, then blur, then block)
- Store listing

## License

[MIT](LICENSE)
