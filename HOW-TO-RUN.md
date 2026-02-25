# Running WalkPlayer

> **No build step.** This is plain HTML + CSS + JS.
> Save a file → refresh the browser. That's it.
> If you don't see your changes, see **"Why don't I see my changes?"** below.

## Start

Pick any of these — whichever you have installed:

```bash
# Python (built into macOS)
python3 -m http.server 8080

# Node — npx (no install needed)
npx serve .

# Node — http-server
npx http-server . -p 8080
```

Then open **http://localhost:8080** in your browser.

> The app must run over `localhost` (or HTTPS). Opening `index.html`
> directly as a file (`file://…`) will break the service worker and
> the `<script type="module">`.

## Use on iPhone

1. Start the server on your Mac.
2. Find your Mac's local IP (`System Settings → Wi-Fi → Details`, or run `ipconfig getifaddr en0`).
3. Open `http://<mac-ip>:8080` in Safari on your iPhone.
4. **Share → Add to Home Screen** for a full-screen, app-like experience.

Audio is batch-scheduled so it keeps playing with the screen off.
The lock screen controls (play/pause/skip) work via Media Session.

## Why don't I see my changes?

The service worker (`sw.js`) caches all app files so they load fast offline.
This means a normal refresh still shows the old version.

**Quickest fix — hard refresh bypassing cache:**

| Browser | Shortcut |
|---------|----------|
| Chrome / Edge (Mac) | `Cmd + Shift + R` |
| Chrome / Edge (Windows) | `Ctrl + Shift + R` |
| Safari | `Cmd + Option + R` |
| Firefox | `Ctrl + Shift + R` |

**Better for active development — tell the service worker to always update:**

1. Open **DevTools** (`F12` or `Cmd+Option+I`)
2. Go to **Application** tab → **Service Workers** (Chrome/Edge)
   or **Storage** → **Service Workers** (Firefox)
3. Check **"Update on reload"**

Now every normal refresh (`Cmd+R`) will pick up your latest files.
Uncheck it when you're done developing.

**Nuclear option — wipe everything:**

1. DevTools → Application → Service Workers → **Unregister**
2. DevTools → Application → Cache Storage → delete `walkplayer-v1`
3. Hard-refresh (`Cmd+Shift+R`)

## Stop

Press **Ctrl+C** in the terminal where the server is running.

### Clean up the service worker (optional)

If you change the code and want a completely fresh start in the browser:

1. Open DevTools → **Application** (Chrome) or **Storage** (Safari / Firefox).
2. Under **Service Workers**, click **Unregister**.
3. Under **Cache Storage**, delete the `walkplayer-v1` cache.
4. Hard-refresh the page (`Cmd+Shift+R`).

On iPhone: **Settings → Safari → Advanced → Website Data** → find
`localhost` → swipe to delete.
