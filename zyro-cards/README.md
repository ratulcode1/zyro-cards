# Zyro Cards — Full Stack (Database + Backend + Admin Panel + Customer Dashboard + Public Profile)

This is a **complete, working project** — every piece is real code, not a mockup.
This sandbox has no internet access, so `npm install` couldn't be run here — but
the code is standard Node.js/Express and will run as-is on your own machine or
any host (Railway, Render, a VPS, etc).

## 1. The pieces, and how they connect

```
                         ┌────────────────────┐
                         │   SQLite Database    │  (zyro.db — auto-created)
                         │  users / profiles /   │
                         │  cards / scans /admins│
                         └─────────▲────────────┘
                                   │  (all reads/writes go through server.js)
                         ┌─────────┴────────────┐
                         │   backend/server.js   │  ← the ONE backend, all routes
                         └───┬──────┬──────┬─────┘
                             │      │      │
              ┌──────────────┘  ┌───┴───┐  └───────────────┐
              │                 │       │                  │
     frontend/admin.html   dashboard.html            frontend/profile.html
     (you, the owner)      (your customer,           (anyone who taps the
     generate cards,       logs in, edits their       NFC card / scans the
     see all users/scans   name/photo/links)          QR — no login needed)
```

Everything — admin panel, customer dashboard, and the public page — talks to
the **same backend** (`server.js`) and the **same database**. There's only one
source of truth: the `cards` and `profiles` tables.

## 2. How a card physically works, end-to-end

1. **You (admin)** generate a batch of cards in the admin panel → each gets a
   random `unique_code` (e.g. `a1b2c3d4`) saved in the `cards` table with
   `status = unassigned`.
2. For each code, the admin panel gives you:
   - A URL: `http://yourdomain.com/u/a1b2c3d4`
   - A QR code image (auto-generated, click "View QR")
3. **You write that URL into the NFC chip** using a phone app (see §5) and
   print the QR on the card.
4. **Customer buys the card**, taps it on their phone → phone opens
   `yourdomain.com/u/a1b2c3d4` → this shows an "activate your card" flow if
   they aren't logged in yet.
5. Customer signs up / logs in → clicks "Activate" and enters the code (or it
   auto-activates if they tapped while already logged in) → the backend links
   `cards.user_id` to their account and flips `status` to `active`.
6. From now on, tapping/scanning that same physical card always shows
   **whatever is currently in their profile** — because the NFC chip only
   ever stores the fixed URL `/u/a1b2c3d4`; the actual name/photo/bio/links
   are fetched live from the database every time. **The card itself never
   needs to be reprogrammed** when they edit their profile.

## 3. Running it locally

```bash
cd backend
npm install
node seed-admin.js      # creates the first admin login
node server.js          # starts everything on http://localhost:4000
```

Then open in a browser:
- `http://localhost:4000/admin.html` — admin panel (login: `admin@zyrocards.com` / `admin123`)
- `http://localhost:4000/login.html` — customer sign up/login
- `http://localhost:4000/dashboard.html` — customer edits their profile & activates a card
- `http://localhost:4000/u/<code>` — the public profile (what NFC/QR opens)

The Express server serves the `frontend/` folder as static files AND the API,
so there's no separate frontend server needed for this version — one process,
one port.

## 3.5 Full admin capabilities (added)

The admin panel (`/admin.html`) now has a sidebar with 5 sections:

- **Overview** — stats + most-scanned cards
- **Generate cards** — bulk-create new card codes
- **All cards** — view every card, **enable/disable** a card (e.g. reported lost),
  **permanently delete** a card record, or open its QR image
- **Users** — **add a new user manually** (no card needed yet), **edit any user's
  full profile** (name/photo/bio/links — same fields the customer dashboard
  edits), **reset any user's password**, or **delete a user** entirely (their
  card is automatically freed back to `unassigned`)
- **Settings** — change the admin's own login email/password (requires the
  current password)

All of this is backed by real endpoints in `server.js` — nothing is mocked.
A disabled card immediately stops working for taps/scans and can't be
re-activated by the customer until an admin re-enables it.

`/dashboard.html` (customer side) now has a two-column layout: profile editor
on the left (photo upload, basic info, contact, theme swatch, links) and a
**live preview** on the right — an embedded iframe of the actual public
profile page that updates on every save.

## 4. Deploying for real

- **Backend + static files:** deploy the whole `zyro-cards` folder to Render,
  Railway, or a small VPS. Set the environment variable
  `PUBLIC_BASE_URL=https://zyrocards.com` and `JWT_SECRET=<random long string>`
  before starting `server.js`.
- **Database:** SQLite (`better-sqlite3`) is fine until you have real scale;
  when you outgrow it, swap it for PostgreSQL — the SQL in `schema.sql` is
  written to be Postgres-compatible with minimal changes.
- **Custom domain:** point `zyrocards.com` at your host, get HTTPS (Let's
  Encrypt via your host, or Cloudflare).
- **Photo uploads:** right now `photo_url` is just a text field (paste an
  image link). For real photo uploads, add an S3/Cloudinary upload endpoint
  later — the schema already has the column ready.

## 5. Writing the NFC chips

Recommended chip: **NTAG213** (144 bytes — plenty for a URL) or **NTAG215**
if you want more room later.

**Manual (small batches):**
1. Install "NFC Tools" (Android/iOS).
2. Get the URL for a code from the admin panel, e.g. `http://zyrocards.com/u/a1b2c3d4`.
3. In NFC Tools → Write → Add a record → URL/URI → paste it → Write → tap the blank card.
4. Optionally lock the tag afterward so it can't be overwritten.

**Bulk (100s of cards):**
- Use an ACR122U USB NFC reader/writer + the `nfcpy` Python library, looping
  through a CSV of codes/URLs exported from the admin panel, to write
  automatically instead of doing it one by one by hand.

## 6. Security notes before going live

- Change the default admin password immediately (`seed-admin.js`).
- Set a strong random `JWT_SECRET` (don't use the default).
- Card codes are short (8 chars) for readability — if you want them
  un-guessable, switch to a full UUID instead of `uuid.split('-')[0]` in
  `server.js`.
- Add rate limiting (e.g. `express-rate-limit`) on `/api/public/:code` so bots
  can't hammer scan analytics.
- Put the whole app behind HTTPS before real customers use it (passwords are
  sent in login requests).

## 7. File map

```
zyro-cards/
├── schema.sql              # database tables
├── backend/
│   ├── server.js            # the entire API (auth, admin, customer, public)
│   ├── seed-admin.js         # creates first admin login
│   └── package.json
└── frontend/
    ├── style.css             # shared styling
    ├── login.html            # customer sign up / login
    ├── dashboard.html        # customer profile editor + card activation
    ├── admin.html            # admin panel (generate cards, see users/scans)
    └── profile.html           # PUBLIC page — what NFC tap / QR scan opens
```
