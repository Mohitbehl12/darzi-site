# Darzi — Digital Tailor

AI-assisted custom clothing: design studio, phone-camera body measurement,
Fit Lock + 100% Fit Guarantee, ordering, customer accounts and a workshop dashboard.

| Part | Where | Render service |
|---|---|---|
| Website (single file) | `index.html` | `darzi-test` (static) → https://darzi-test.onrender.com |
| Body detection model | `vendor/mediapipe-pose/` (Apache-2.0, self-hosted) | served by `darzi-test` |
| API | `server/` (Node + Express) | `darzi-api` (web, Singapore) → https://darzi-api-d385.onrender.com |
| Database | Postgres 16 | `darzi-db` (Singapore) |

## API environment variables (Render → darzi-api → Environment)
| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Internal Database URL from darzi-db |
| `STAFF_PHONES` | yes | Comma-separated mobile numbers allowed into the workshop |
| `ADMIN_PIN` | yes | Extra PIN for staff sign-in while SMS is in test mode |
| `ALLOWED_ORIGINS` | set | Website origins allowed to call the API |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | later | Real SMS OTP. Without them the code is shown on screen (test mode) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | later | Real payments. Without them orders are marked as test payments |
| `JWT_SECRET` | optional | Signing key; derived from `DATABASE_URL` if unset |

Prices are recalculated on the server from `server/pricing.json`.
After changing prices in `index.html`, run `node tools/extract-pricing.js` and commit.

## Run locally
```bash
# API (needs a Postgres)
cd server && npm ci && DATABASE_URL=postgres://... STAFF_PHONES=9XXXXXXXXX ADMIN_PIN=123456 PORT=3999 node index.js
# Website (talks to http://localhost:3999 when not on onrender.com)
python3 -m http.server 8080   # open http://localhost:8080
```

## Main API routes
Auth `POST /api/auth/otp`, `POST /api/auth/verify` · Account `GET/PATCH /api/me` ·
Profiles `PUT/DELETE /api/profiles/:id` · Designs `POST/DELETE /api/designs` ·
Orders `POST /api/orders`, `POST /api/orders/:id/pay/verify`, `POST /api/orders/:id/feedback` ·
Workshop (staff) `GET /api/admin/orders`, `PATCH /api/admin/orders/:id`, `GET /api/admin/customers`,
`GET/POST/PATCH/DELETE /api/admin/fabrics`, `GET /api/admin/reports`
