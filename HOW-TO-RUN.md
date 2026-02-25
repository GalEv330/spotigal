# Running WalkPlayer

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
