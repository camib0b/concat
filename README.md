# Concat

Join split match footage in the browser. This is a WebAssembly use case.

It runs FFmpeg compiled to WebAssembly ([ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)) inside the browser to join the footage. There is no server, and nothing is uploaded.

The WebAssembly module loads only after a join starts, and only for the in-memory path, which keeps the parts and the result in the tab. The streaming path writes the result straight to disk and does not load the module.

Served at [camilaescudero.cl/concat](https://camilaescudero.cl/concat).

## Develop

```bash
npm install
npm run dev
```

Open `http://localhost:5173/concat/`.

## Deploy

```bash
npm run build && npx wrangler deploy
```

The build writes the app under `dist/concat/` so assets resolve at `/concat/`. The Worker is assets-only, with SPA fallback, on `camilaescudero.cl/concat` and `camilaescudero.cl/concat/*`.
