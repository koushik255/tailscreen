# TailScreen

TailScreen is a small, installable web app for browsing videos on a server from an iPad. Over your Tailscale network you can:

- search the server's video library;
- play browser-supported video directly; and
- fall back to client-side Mediabunny playback for other containers and codecs.

The compatibility player decodes video progressively and sends decoded audio through Web Audio. AC-3, DTS, and ProRes fallback decoders are included. It does not download an entire multi-gigabyte movie into memory before playback.

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
  "extraThresholdMb": 800,
  "libraries": [
    { "name": "Movies", "path": "/srv/media/Movies" },
    { "name": "TV Shows", "path": "/srv/media/TV Shows" }
  ]
}
```

`config.json` is ignored by Git, so every server can have different paths without creating Git conflicts or publishing its filesystem layout.
All paths must be absolute, readable directories. Restart TailScreen after changing `config.json`.
Videos smaller than `extraThresholdMb` are grouped under **Extras** at the bottom of the library. The default cutoff is 800 MB.

Then start the app:

```bash
npm start
```

The library is rescanned whenever the page loads. `scanIntervalMs` also keeps it fresh while the server stays running. `PORT`, `SCAN_INTERVAL_MS`, `EXTRA_THRESHOLD_MB`, and `MEDIA_DIRS` are available as optional environment-variable overrides.

## Open it on the iPad

1. Connect the server and iPad to the same tailnet.
2. On the server, run `tailscale ip -4` to find its Tailscale IP, or use its MagicDNS name.
3. In iPad Safari, open `http://SERVER_NAME:8787`.
4. Use **Share → Add to Home Screen** to install it like an app.

If Safari refuses to install service-worker features over plain HTTP, use Tailscale Serve to provide tailnet-only HTTPS:

```bash
tailscale serve --bg 8787
```

Then open the HTTPS URL printed by Tailscale. Plain tailnet HTTP works for basic browsing, but HTTPS is recommended because browser media APIs and installable-PWA features can require a secure context.

## Security

The process listens on `0.0.0.0:8787`, which can include your LAN as well as Tailscale. Do not port-forward this port to the public internet. Prefer a host firewall and a Tailscale ACL that only allow your iPad/user to reach TCP port 8787 on this server.

## Development

```bash
npm run dev
npm test
npm run typecheck
```

The server and browser code are TypeScript. `npm start` builds the browser bundle before starting the server.
