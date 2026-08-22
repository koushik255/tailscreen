# TailScreen

TailScreen is a small, installable web app for browsing videos on a server from an iPad. Over your Tailscale network you can:

- search the server's video library;
- stream a supported video directly to the iPad; and
- ask the server to open a video in its local media player.

No cloud service or public port is required. This first version intentionally relies on your Tailscale network and ACLs as the access boundary.

## Server setup

Requirements: Node.js 20+ and Tailscale installed on both devices.

```bash
npm install
cp .env.example .env
```

Edit `.env`, then load it and start the app:

```bash
set -a
source .env
set +a
npm start
```

For multiple folders, use your operating system's path separator:

```dotenv
# macOS/Linux
MEDIA_DIRS=/Volumes/Media/Movies:/Volumes/Media/Home Videos
```

The default launcher is `open` on macOS and `xdg-open` on Linux. To force VLC, for example:

```dotenv
PLAYER_COMMAND=/Applications/VLC.app/Contents/MacOS/VLC
PLAYER_ARGS_JSON=["--fullscreen","{file}"]
```

`PLAYER_ARGS_JSON` is passed directly to the program without a shell. Keep `{file}` where the selected video's absolute path should go.

## Open it on the iPad

1. Connect the server and iPad to the same tailnet.
2. On the server, run `tailscale ip -4` to find its Tailscale IP, or use its MagicDNS name.
3. In iPad Safari, open `http://SERVER_NAME:8787`.
4. Use **Share → Add to Home Screen** to install it like an app.

If Safari refuses to install service-worker features over plain HTTP, use Tailscale Serve to provide tailnet-only HTTPS:

```bash
tailscale serve --bg 8787
```

Then open the HTTPS URL printed by Tailscale. The website itself and its launch buttons still work over plain tailnet HTTP; HTTPS is mainly for the full installable-PWA behavior.

## Security

The process listens on `0.0.0.0:8787`, which can include your LAN as well as Tailscale. Do not port-forward this port to the public internet. Prefer a host firewall and a Tailscale ACL that only allow your iPad/user to reach TCP port 8787 on this server.

## Development

```bash
npm run dev
npm test
```

The browser UI is plain HTML/CSS/JavaScript, so there is no frontend build step.
