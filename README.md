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
2. **Shows a live timer.** A full-width bar sits at the very top of the page,
   and the site starts below it:
   **DoomedScroller** on the left, **Time wasted today** in the middle (time in soft red)
   (updating every second), and **Total time for youtube** in green on the
   right (the day's allowance, including extensions). It shows *paused* when
   time isn't being counted, and stays visible over fullscreen video.

   **The bar grows as you near the limit,** squeezing the site into less of
   the window: 10% of the window height at 80% of your time, then 15%, 20% and
   25% at 85%, 90% and 95%. After you take an extension it stays at 25%.

   The extra space shows **a philosophy quote to read instead of the feed**:
   Kant, Nietzsche, Marcus Aurelius, Seneca and others, with the author's
   name. Each quote stays up for 60 seconds, so there's time to actually read
   and think about it. A strip along the bottom shows how much of today's time
   is used. The background colour moves through three stages:

   | Stage | When | Colour |
   |---|---|---|
   | Calm | 80% | deep teal |
   | Caution | 85–90% | amber |
   | Stop | 95%+, or after an extension | muted crimson |

   Quotes come from two free APIs (see [Privacy](#privacy) and
   [Credits](#credits)), fetched about once a day and kept locally. If they're
   unreachable, or `onlineQuotes` is off, a built-in set of classic quotes is
   used instead.
3. **Warns.** When a site reaches the day's limit (default: 15 min), a
   full-screen overlay appears and pauses any video. You can close the tab or
   take **5 more minutes**.
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
  the limits.

### Limit changes take 2 hours to apply

On purpose. When you're mid-scroll and want "just 10 more minutes", raising
the limit right then doesn't help: the new limits only take effect 2 hours
after you save them. Until then the old ones stay in force and the settings
page shows a countdown. Saving again restarts the 2 hours. Cancelling a pending
change takes effect immediately.

## Privacy

- **Your usage stays on your device.** Time spent is saved in the browser's
  local extension storage and never sent anywhere. There's no server of ours,
  no analytics and no account.
- **Quote fetching is the only network traffic.** About once a day the
  extension downloads quotes from `philosophyapi.pythonanywhere.com` and
  `www.stoic-quotes.com`. These are plain requests with no cookies and nothing
  about you or your browsing in them, but like any web request they reveal
  your IP address to those services. Set `onlineQuotes: false` in `shared.js`
  to turn this off; then the extension makes no network requests at all.
- **Minimal permissions.** It asks for `storage` and access to the two quote
  hosts above. Its page script runs only on `youtube.com`, `reddit.com` and
  `linkedin.com`.
- **No content is read.** It records time only, not what you look at.
- **History:** 30 days of daily totals are kept, then deleted.

## Configuration

Code-level defaults live in `CONFIG` at the top of [`shared.js`](shared.js):

| Key | Default | Meaning |
|---|---|---|
| `baseMinutes` | 15 | Warn after this many active minutes per site per day |
| `extendMinutes` | 5 | Minutes added per extension |
| `maxExtensions` | 3 | Extensions before the site is blocked |
| `idleMs` | 60 000 | Stop counting time after this long with no input |
| `coolOffMs` | 2 h | Delay before new limits apply |
| `retainDays` | 30 | Days of history kept |
| `uninstallUrl` | empty | Page the browser opens after the extension is removed |
| `onlineQuotes` | true | Fetch philosophy quotes online; `false` = built-in quotes only, no network |
| `quoteRotateMs` | 60 000 | How long each quote stays on screen |
| `quoteRefreshMs` | 24 h | Fetch new quotes when the local pool is older than this |

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
- **Fullscreen.** While a video is fullscreen the browser only draws that
  element, so the timer bar and overlay move inside it and move back on exit.

### Adding a site

1. Add it to `SITES` in `shared.js`.
2. Add its URL pattern to `content_scripts.matches` in `manifest.json`.
3. Reload the extension.

## Roadmap

- Sites configurable from the settings page
- Weekly history chart
- Escalating friction (toast, then blur, then block)
- Choose philosophy schools or authors for the quotes in settings
- Store listing

## Credits

Philosophy quotes are fetched from these free, community-run APIs:

- [Philosophy API](https://philosophyapi.pythonanywhere.com/api/): quotes from
  philosophers across schools
- [Stoic Quotes](https://www.stoic-quotes.com/): Marcus Aurelius, Seneca,
  Epictetus

Thanks to their maintainers. Please be gentle with them: the extension fetches
about once a day.

## License

[MIT](LICENSE)
