# Concat

Join split match footage in the browser. Put the parts in order and save one file.

The join runs fully in the browser. Nothing is uploaded. It uses [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).

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
