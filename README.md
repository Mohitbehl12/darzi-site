# Darzi — Digital Tailor (test build)

Clickable prototype of an AI-powered custom clothing and digital tailoring website:
design studio, guided 360° body measurement with Fit Lock, virtual fit preview,
ordering, customer dashboard, tailor/workshop dashboard and 2026 trend catalogue.

Single-file static site: `index.html`. No build step, no backend yet.

## Deploy on Render
1. Render dashboard → **New → Blueprint**.
2. Connect this GitHub repo. Render reads `render.yaml`.
3. Click **Apply**. You get `https://darzi-test.onrender.com` (or similar).

Every push to `main` redeploys automatically. Pull requests get preview URLs.

## Run locally
```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

## Prototype limits
- Camera capture, AI parsing, payments and orders are simulated in the browser.
- Data is stored in the browser's localStorage only.
- `noindex` is set so search engines don't list this test build.
