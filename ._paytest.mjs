// Temporary authenticated-pay test. Safe to delete.
import { MongoClient, ObjectId } from "mongodb";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import Stripe from "stripe";
import "dotenv/config";

const DEV = "http://localhost:3000";
const BASE = "http://localhost:5000";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("rental-platform");

const USER_ID = "6aff2a2e32f5ff67a8cecd76";
const MARKER = "e2e-paytest@local";
const TOKEN = "e2eMintedSessionToken000000000000";

// Better Auth signs its session cookie: value = token + "." + HMAC-SHA256
// (base64) — same format as its own test-utils cookie builder.
const clientEnv = readFileSync(
  "D:/Assignment/My Assignment/Assignment-009/b14-a9-rental-platform-client/.env",
  "utf8"
);
const secret = clientEnv.match(/^BETTER_AUTH_SECRET=(.*)$/m)?.[1]?.trim();
if (!secret) { console.log("BETTER_AUTH_SECRET not found"); process.exit(1); }
const signature = createHmac("sha256", secret).update(TOKEN).digest("base64");
const signedCookie = `${TOKEN}.${signature}`;

const equip = await db.collection("equipment").findOne({ availableQuantity: { $gte: 1 } });

const prep = await fetch(`${BASE}/api/prepareBooking`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    equipmentId: String(equip._id), customerId: USER_ID, customerEmail: MARKER,
    equipmentName: equip.name, startDate: "2027-01-05", endDate: "2027-01-07",
    quantity: 1, contactNumber: "01700000000", deliveryAddress: "Dhaka", notes: "",
  }),
}).then((r) => r.json());
console.log("pending payment:", prep.success, prep.paymentId, "amount=", prep.amount);
if (!prep.success) process.exit(1);

// Real Date objects (and ObjectId) — Better Auth compares them as dates,
// strings would never match its $gt / equality queries.
const now = new Date();
await db.collection("session").insertOne({
  token: TOKEN,
  userId: new ObjectId(USER_ID),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  createdAt: now,
  updatedAt: now,
  ipAddress: "0000:0000:0000:0000:0000:0000:0000:0000",
  userAgent: "e2e-test",
});

let location = null;
let status = 0;
try {
  const res = await fetch(`${DEV}/api/checkout_sessions`, {
    method: "POST",
    body: new URLSearchParams({ paymentId: prep.paymentId }),
    headers: { Cookie: `better-auth.session_token=${signedCookie}` },
    redirect: "manual",
  });
  status = res.status;
  location = res.headers.get("location");
  console.log(`POST signed-in -> ${status}  location=${location}`);
} finally {
  await db.collection("session").deleteOne({ token: TOKEN });
  await db.collection("payments").deleteOne({ _id: new ObjectId(prep.paymentId) });
}

const ok = status === 303 && location && location.startsWith("https://checkout.stripe.com/");
console.log(ok ? "PASS  authenticated pay -> 303 to Stripe Checkout" : "FAIL  unexpected response");

if (ok) {
  const m = location.match(/cs_test_[A-Za-z0-9]+/);
  if (m) {
    try {
      await stripe.checkout.sessions.expire(m[0]);
      console.log("probe checkout session expired:", m[0]);
    } catch (e) {
      console.log("expire skipped:", e.message);
    }
  }
}
const left = await db.collection("payments").countDocuments({ customerEmail: MARKER });
const sessions = await db.collection("session").countDocuments({ token: TOKEN });
console.log(`leftovers: payments=${left} sessions=${sessions}  (both should be 0)`);
await client.close();
process.exit(ok && left === 0 && sessions === 0 ? 0 : 1);
