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
cp config.example.json config.json
```

Edit `config.json` and set the absolute paths used on this server:

```json
{
  "port": 8787,
  "scanIntervalMs": 30000,
  "libraries": [
    { "name": "Movies", "path": "/srv/media/Movies" },
    { "name": "TV Shows", "path": "/srv/media/TV Shows" }
  ]
}
```

`config.json` is ignored by Git, so every server can have different paths without creating Git conflicts or publishing its filesystem layout.
All paths must be absolute, readable directories. Restart TailScreen after changing `config.json`.

Then start the app:

```bash
npm start
```

The default launcher is `open` on macOS and `xdg-open` on Linux. To use a specific player, add a `player` section to `config.json`:

```json
{
  "port": 8787,
  "scanIntervalMs": 30000,
  "libraries": [
    { "name": "Movies", "path": "/srv/media/Movies" }
  ],
  "player": {
    "command": "/usr/bin/mpv",
    "args": ["--fullscreen", "{file}"]
  }
}
```

The arguments are passed directly to the program without a shell. Keep `{file}` where the selected video's absolute path should go. `PORT`, `SCAN_INTERVAL_MS`, `MEDIA_DIRS`, `PLAYER_COMMAND`, and `PLAYER_ARGS_JSON` remain available as optional environment-variable overrides.

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
