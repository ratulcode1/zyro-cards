// ============================================
// ZYRO CARDS — BACKEND SERVER
// One file, fully commented, so every connection is visible.
// ============================================
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { DatabaseSync } = require("node:sqlite");
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";
const PORT = process.env.PORT || 4000;
// This is the public domain that gets written into every NFC chip / QR code.
// e.g. https://zyrocards.com  -> a tapped card opens https://zyrocards.com/u/abc123
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:4000";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend"))); // serves admin.html, dashboard.html, profile.html

// ---------- PHOTO UPLOADS ----------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use("/uploads", express.static(uploadsDir)); // uploaded photos become publicly viewable at /uploads/<file>

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

// ---------- DATABASE ----------
const db = new DatabaseSync(path.join(__dirname, "zyro.db"));
db.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));

// ---------- HELPERS ----------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}
function authCustomer(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(header.replace("Bearer ", ""), JWT_SECRET);
    if (decoded.role !== "customer") throw new Error("wrong role");
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
function authAdmin(req, res, next) {
  const header = req.headers.authorization;
  const rawToken = header ? header.replace("Bearer ", "") : req.query.t;
  if (!rawToken) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(rawToken, JWT_SECRET);
    if (decoded.role !== "admin") throw new Error("wrong role");
    req.adminId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// =====================================================
// CUSTOMER AUTH  (register / login)
// =====================================================
app.post("/api/auth/register", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email & password required" });
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hash);
  // create an empty profile row immediately so it's always there to edit
  db.prepare("INSERT INTO profiles (user_id, full_name) VALUES (?, ?)").run(info.lastInsertRowid, "");

  const token = signToken({ id: info.lastInsertRowid, role: "customer" });
  res.json({ token, userId: info.lastInsertRowid });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = signToken({ id: user.id, role: "customer" });
  res.json({ token, userId: user.id });
});

// =====================================================
// CUSTOMER — CARD ACTIVATION
// This is the step that LINKS a physical NFC card to a logged-in
// customer's account. Before this, the card's user_id is NULL.
// =====================================================
app.post("/api/cards/activate", authCustomer, (req, res) => {
  const { code } = req.body;
  const card = db.prepare("SELECT * FROM cards WHERE unique_code = ?").get(code);
  if (!card) return res.status(404).json({ error: "No such card code" });
  if (card.status === "disabled") return res.status(403).json({ error: "This card has been disabled by the admin" });
  if (card.status === "active" && card.user_id !== req.userId) {
    return res.status(409).json({ error: "This card is already linked to another account" });
  }
  db.prepare(
    "UPDATE cards SET user_id = ?, status = 'active', activated_at = datetime('now') WHERE id = ?"
  ).run(req.userId, card.id);
  res.json({ success: true, publicUrl: `${PUBLIC_BASE_URL}/u/${card.unique_code}` });
});

app.get("/api/cards/me", authCustomer, (req, res) => {
  const cards = db.prepare("SELECT unique_code, status, activated_at FROM cards WHERE user_id = ?").all(req.userId);
  res.json(cards.map((c) => ({ ...c, publicUrl: `${PUBLIC_BASE_URL}/u/${c.unique_code}` })));
});

// =====================================================
// CUSTOMER — PROFILE EDIT (this is what the dashboard calls;
// any change here is instantly reflected on the public page that
// the NFC tap / QR scan opens — the card itself never needs
// reprogramming, only the URL it points to stays fixed)
// =====================================================
app.get("/api/profile/me", authCustomer, (req, res) => {
  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(req.userId);
  const links = db.prepare("SELECT * FROM profile_links WHERE profile_id = ? ORDER BY sort_order").all(profile.id);
  res.json({ ...profile, links });
});

app.put("/api/profile/me", authCustomer, (req, res) => {
  const { full_name, job_title, company, bio, phone, email_public, photo_url, theme, links } = req.body;
  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(req.userId);

  db.prepare(
    `UPDATE profiles SET full_name=?, job_title=?, company=?, bio=?, phone=?, email_public=?, photo_url=?, theme=?, updated_at=datetime('now')
     WHERE user_id=?`
  ).run(full_name, job_title, company, bio, phone, email_public, photo_url, theme, req.userId);

  if (Array.isArray(links)) {
    db.prepare("DELETE FROM profile_links WHERE profile_id = ?").run(profile.id);
    const insert = db.prepare("INSERT INTO profile_links (profile_id, label, url, sort_order) VALUES (?, ?, ?, ?)");
    links.forEach((l, i) => insert.run(profile.id, l.label, l.url, i));
  }
  res.json({ success: true });
});

// Upload a profile photo — customer picks a file from their phone/computer,
// it's saved on the server, and the profile is updated to point at it.
app.post("/api/profile/photo", authCustomer, upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  const photoUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;
  db.prepare("UPDATE profiles SET photo_url = ?, updated_at = datetime('now') WHERE user_id = ?").run(photoUrl, req.userId);
  res.json({ photo_url: photoUrl });
});

// =====================================================
// PUBLIC — this is the exact route the NFC chip / QR code points to.
// e.g. NFC chip stores: https://zyrocards.com/u/abc123
// No login needed — anyone who taps/scans sees this.
// =====================================================
app.get("/api/public/:code", (req, res) => {
  const card = db.prepare("SELECT * FROM cards WHERE unique_code = ?").get(req.params.code);
  if (!card || card.status !== "active") return res.status(404).json({ error: "Card not active" });

  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(card.user_id);
  const links = db.prepare("SELECT * FROM profile_links WHERE profile_id = ? ORDER BY sort_order").all(profile.id);

  // log the scan for analytics
  db.prepare("INSERT INTO scans (card_id, ip_address, user_agent) VALUES (?, ?, ?)").run(
    card.id,
    req.ip,
    req.headers["user-agent"] || ""
  );

  res.json({ ...profile, links });
});

// Downloads a .vcf contact file for the "Save contact" button on the public page
app.get("/api/vcard/:code", (req, res) => {
  const card = db.prepare("SELECT * FROM cards WHERE unique_code = ?").get(req.params.code);
  if (!card || card.status !== "active") return res.status(404).send("Not found");
  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(card.user_id);

  const vcf = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${profile.full_name || ""}`,
    `ORG:${profile.company || ""}`,
    `TITLE:${profile.job_title || ""}`,
    profile.phone ? `TEL;TYPE=CELL:${profile.phone}` : "",
    profile.email_public ? `EMAIL:${profile.email_public}` : "",
    `URL:${PUBLIC_BASE_URL}/u/${card.unique_code}`,
    "END:VCARD",
  ].filter(Boolean).join("\n");

  res.set("Content-Type", "text/vcard");
  res.set("Content-Disposition", `attachment; filename="${(profile.full_name||'contact').replace(/\s+/g,'_')}.vcf"`);
  res.send(vcf);
});

// =====================================================
// ADMIN — login, bulk card generation, oversight
// =====================================================
app.post("/api/admin/login", (req, res) => {
  const { email, password } = req.body;
  const admin = db.prepare("SELECT * FROM admins WHERE email = ?").get(email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = signToken({ id: admin.id, role: "admin" });
  res.json({ token });
});

// Generate N brand-new cards (unassigned). Call this BEFORE printing
// a physical batch — then write each unique_code's URL to an NFC chip
// and a QR image using the /api/admin/cards/:code/qr endpoint below.
app.get("/api/admin/me", authAdmin, (req, res) => {
  const admin = db.prepare("SELECT id, email FROM admins WHERE id = ?").get(req.adminId);
  res.json(admin);
});

app.post("/api/admin/cards/generate", authAdmin, (req, res) => {
  const { count = 1, batchName = "" } = req.body;
  const insert = db.prepare("INSERT INTO cards (unique_code, batch_name) VALUES (?, ?)");
  const codes = [];
  db.exec("BEGIN");
  try {
    for (let i = 0; i < count; i++) {
      const code = uuidv4().split("-")[0]; // short 8-char code, e.g. "a1b2c3d4"
      insert.run(code, batchName);
      codes.push(code);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "Card generation failed" });
  }
  res.json({ generated: codes, urls: codes.map((c) => `${PUBLIC_BASE_URL}/u/${c}`) });
});

// Returns a PNG QR code for a given card code — print this on the card
app.get("/api/admin/cards/:code/qr", authAdmin, async (req, res) => {
  const url = `${PUBLIC_BASE_URL}/u/${req.params.code}`;
  const png = await QRCode.toBuffer(url, { width: 400 });
  res.type("png").send(png);
});

app.get("/api/admin/cards", authAdmin, (req, res) => {
  const cards = db
    .prepare(
      `SELECT cards.*, users.email as owner_email
       FROM cards LEFT JOIN users ON cards.user_id = users.id
       ORDER BY cards.created_at DESC`
    )
    .all();
  res.json(cards);
});

app.get("/api/admin/users", authAdmin, (req, res) => {
  const users = db
    .prepare(
      `SELECT users.id, users.email, users.created_at, profiles.full_name
       FROM users LEFT JOIN profiles ON profiles.user_id = users.id
       ORDER BY users.created_at DESC`
    )
    .all();
  res.json(users);
});

// Full detail of one user — profile, links, and linked cards (for the admin edit drawer)
app.get("/api/admin/users/:id", authAdmin, (req, res) => {
  const user = db.prepare("SELECT id, email, created_at FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(user.id);
  const links = profile ? db.prepare("SELECT * FROM profile_links WHERE profile_id = ? ORDER BY sort_order").all(profile.id) : [];
  const cards = db.prepare("SELECT unique_code, status, batch_name, activated_at FROM cards WHERE user_id = ?").all(user.id);
  res.json({ ...user, profile: profile || {}, links, cards });
});

// Admin creates a new customer account directly (no card required yet)
app.post("/api/admin/users", authAdmin, (req, res) => {
  const { email, password, full_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email & password required" });
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email already registered" });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hash);
  db.prepare("INSERT INTO profiles (user_id, full_name) VALUES (?, ?)").run(info.lastInsertRowid, full_name || "");
  res.json({ success: true, userId: info.lastInsertRowid });
});

// Admin edits ANY user's profile (full override — same fields the customer dashboard edits)
app.put("/api/admin/users/:id", authAdmin, (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { full_name, job_title, company, bio, phone, email_public, photo_url, theme, links } = req.body;
  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(user.id);

  db.prepare(
    `UPDATE profiles SET full_name=?, job_title=?, company=?, bio=?, phone=?, email_public=?, photo_url=?, theme=?, updated_at=datetime('now')
     WHERE user_id=?`
  ).run(full_name, job_title, company, bio, phone, email_public, photo_url, theme, user.id);

  if (Array.isArray(links)) {
    db.prepare("DELETE FROM profile_links WHERE profile_id = ?").run(profile.id);
    const insert = db.prepare("INSERT INTO profile_links (profile_id, label, url, sort_order) VALUES (?, ?, ?, ?)");
    links.forEach((l, i) => insert.run(profile.id, l.label, l.url, i));
  }
  res.json({ success: true });
});

// Admin resets a customer's password directly (e.g. they're locked out)
app.put("/api/admin/users/:id/password", authAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
  res.json({ success: true });
});

// Admin deletes a user entirely (profile + links cascade via schema; any linked
// cards are freed back to 'unassigned' via ON DELETE SET NULL, then we reset them)
app.delete("/api/admin/users/:id", authAdmin, (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id); // cascades to profiles + profile_links
  db.prepare("UPDATE cards SET status = 'unassigned', activated_at = NULL WHERE user_id IS NULL AND status = 'active'").run();
  res.json({ success: true });
});

// Admin changes THEIR OWN login email/password (requires current password)
app.put("/api/admin/account", authAdmin, (req, res) => {
  const { currentPassword, newEmail, newPassword } = req.body;
  const admin = db.prepare("SELECT * FROM admins WHERE id = ?").get(req.adminId);
  if (!admin || !bcrypt.compareSync(currentPassword || "", admin.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  const email = newEmail || admin.email;
  const hash = newPassword ? bcrypt.hashSync(newPassword, 10) : admin.password_hash;
  db.prepare("UPDATE admins SET email = ?, password_hash = ? WHERE id = ?").run(email, hash, req.adminId);
  res.json({ success: true });
});

// Admin blocks/unblocks a card (e.g. reported lost/stolen) without deleting it
app.put("/api/admin/cards/:code/status", authAdmin, (req, res) => {
  const { status } = req.body; // 'active' | 'disabled' | 'unassigned'
  if (!["active", "disabled", "unassigned"].includes(status)) return res.status(400).json({ error: "Invalid status" });
  const card = db.prepare("SELECT * FROM cards WHERE unique_code = ?").get(req.params.code);
  if (!card) return res.status(404).json({ error: "Card not found" });
  if (status === "unassigned") {
    db.prepare("UPDATE cards SET status='unassigned', user_id=NULL, activated_at=NULL WHERE id=?").run(card.id);
  } else {
    db.prepare("UPDATE cards SET status=? WHERE id=?").run(status, card.id);
  }
  res.json({ success: true });
});

// Admin permanently deletes a card record (e.g. a misprinted/miswritten batch entry)
app.delete("/api/admin/cards/:code", authAdmin, (req, res) => {
  const card = db.prepare("SELECT * FROM cards WHERE unique_code = ?").get(req.params.code);
  if (!card) return res.status(404).json({ error: "Card not found" });
  db.prepare("DELETE FROM scans WHERE card_id = ?").run(card.id);
  db.prepare("DELETE FROM cards WHERE id = ?").run(card.id);
  res.json({ success: true });
});

app.get("/api/admin/analytics", authAdmin, (req, res) => {
  const totalScans = db.prepare("SELECT COUNT(*) as n FROM scans").get().n;
  const totalCards = db.prepare("SELECT COUNT(*) as n FROM cards").get().n;
  const activeCards = db.prepare("SELECT COUNT(*) as n FROM cards WHERE status='active'").get().n;
  const totalUsers = db.prepare("SELECT COUNT(*) as n FROM users").get().n;
  const topCards = db
    .prepare(
      `SELECT cards.unique_code, COUNT(scans.id) as scan_count
       FROM scans JOIN cards ON scans.card_id = cards.id
       GROUP BY cards.id ORDER BY scan_count DESC LIMIT 10`
    )
    .all();
  res.json({ totalScans, totalCards, activeCards, totalUsers, topCards });
});

// =====================================================
// Serve the public profile page for /u/:code (pretty URL for NFC/QR)
// =====================================================
app.get("/u/:code", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "profile.html"));
});

app.listen(PORT, () => {
  console.log(`Zyro Cards backend running on ${PUBLIC_BASE_URL} (port ${PORT})`);
});
