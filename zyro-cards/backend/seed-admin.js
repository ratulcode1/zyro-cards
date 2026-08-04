// Run once: node seed-admin.js
// Creates the first admin login (email: admin@zyrocards.com / password: admin123)
// CHANGE THIS PASSWORD immediately after first login in production.
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

const db = new DatabaseSync(path.join(__dirname, "zyro.db"));
db.exec(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));

const email = "admin@zyrocards.com";
const password = "admin123";
const hash = bcrypt.hashSync(password, 10);

try {
  db.prepare("INSERT INTO admins (email, password_hash) VALUES (?, ?)").run(email, hash);
  console.log(`Admin created -> email: ${email}  password: ${password}`);
} catch (e) {
  console.log("Admin already exists, skipping.");
}
