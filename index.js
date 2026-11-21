import express from "express";
import cors from "cors";
import "dotenv/config";
import { Stripe } from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

app.use(cors());
app.use(express.json());

import { MongoClient, ObjectId } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("rental-platform");

// Better Auth creates its collections in the SINGULAR: "user", "session",
// "account", "verification". There is NO "users" collection in this
// database — querying it matched 0 documents, so the `premium` flag that
// /payment/checkout-verify writes was silently never saved.
const usersCollection = db.collection("user");
const equipmentCollection = db.collection("equipment");
const bookingsCollection = db.collection("bookings");
const favouriteCollection = db.collection("favourites");
const paymentsCollection = db.collection("payments");

// http://localhost:5000/api/addEquipment

app.listen(5000, () => {
  console.log("server is running on port 5000");
});

// equipment related api

app.post("/api/addEquipment", async (req, res) => {
  const equipment = req.body;
  const result = await equipmentCollection.insertOne(equipment);
  res.send(result);
});

app.post("/api/addFavourite", async (req, res) => {
  const equipment = req.body;
  const result = await favouriteCollection.insertOne(equipment);
  res.send(result);
});

app.post("/api/addBooking", async (req, res) => {
  const equipment = req.body;
  const result = await bookingsCollection.insertOne(equipment);
  res.send(result);
});

// ── Booking modal flow ─────────────────────────────────────────────

// POST /api/prepareBooking
//
// Called when the customer fills in the booking modal and presses
// "Confirm Booking". It does 4 things, in order:
//   1. validates the 6 fields (always answers with JSON),
//   2. checks how many units are ALREADY booked for those dates,
//   3. calculates the total amount (duration × quantity),
//   4. stores a PENDING payment row in `payments`.
//
// That pending row is what /checkout?paymentId=… displays and what
// Stripe charges. The real booking document is only created LATER, in
// /payment/checkout-verify, after Stripe confirms the money arrived.
app.post("/api/prepareBooking", async (req, res) => {
  const {
    equipmentId,
    customerId,
    customerEmail,
    startDate,
    endDate,
    quantity,
    contactNumber,
    deliveryAddress,
    notes,
  } = req.body;

  // ── 1. basic validation ──
  if (!equipmentId || !ObjectId.isValid(equipmentId)) {
    return res.status(400).json({ success: false, message: "Invalid equipment id" });
  }
  if (!customerId || !customerEmail) {
    return res.status(401).json({ success: false, message: "You must be signed in" });
  }
  if (!startDate || !endDate) {
    return res.status(400).json({ success: false, message: "Rental start and end dates are required" });
  }
  // <input type="date"> always hands us YYYY-MM-DD.
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(startDate) || !datePattern.test(endDate)) {
    return res.status(400).json({ success: false, message: "Dates must be in YYYY-MM-DD format" });
  }
  if (endDate < startDate) {
    return res.status(400).json({ success: false, message: "End date cannot be before the start date" });
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ success: false, message: "Quantity must be at least 1" });
  }
  if (!contactNumber || !deliveryAddress) {
    return res.status(400).json({ success: false, message: "Contact number and delivery address are required" });
  }

  // Rentals cannot start in the past (today, in THIS machine's local time).
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (startDate < today) {
    return res.status(400).json({ success: false, message: "Rental start date cannot be in the past" });
  }

  // ── 2. equipment + availability for the chosen dates ──
  const equipment = await equipmentCollection.findOne({ _id: new ObjectId(equipmentId) });
  if (!equipment) {
    return res.status(404).json({ success: false, message: "Equipment not found" });
  }
  if (equipment.availableQuantity < 1) {
    return res.status(409).json({ success: false, message: "This equipment is out of stock" });
  }

  // Sum the units of every PAID booking whose date range overlaps ours
  // (overlap = other.start <= our.end AND other.end >= our.start).
  // Only paid bookings hold stock; pending/abandoned checkouts don't.
  // The bookings that predate this flow have no date fields, so they
  // never overlap anything — they are ignored here on purpose.
  const overlapping = await bookingsCollection
    .find({
      equipmentId,
      paymentStatus: "paid",
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    })
    .toArray();
  const bookedQuantity = overlapping.reduce((sum, b) => sum + (b.quantity || 0), 0);
  const remaining = equipment.availableQuantity - bookedQuantity;

  if (quantity > remaining) {
    return res.status(409).json({
      success: false,
      message: `Only ${Math.max(remaining, 0)} unit(s) available between ${startDate} and ${endDate}`,
      remaining: Math.max(remaining, 0),
    });
  }

  // ── 3. total = unit price × rental units × quantity ──
  // Inclusive day count: 21 Nov → 21 Nov = 1 day, 21 → 23 = 3 days.
  const [y1, m1, d1] = startDate.split("-").map(Number);
  const [y2, m2, d2] = endDate.split("-").map(Number);
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;

  // How many RENTAL UNITS those days cover depends on how the owner
  // listed the item: a Daily item bills per day, a Weekly item per
  // started week, a Monthly item per started month.
  let units = days;
  if (equipment.rentalType === "Weekly") units = Math.ceil(days / 7);
  if (equipment.rentalType === "Monthly") units = Math.ceil(days / 30);

  const amount = equipment.rentalPrice * units * quantity;

  // ── 4. park a PENDING payment record ──
  const payment = {
    payment_status: "pending",
    userId: customerId,
    customerEmail,
    equipmentId,
    equipmentName: equipment.name,
    rentalType: equipment.rentalType,
    unitPrice: equipment.rentalPrice,
    startDate,
    endDate,
    days,
    units,
    quantity,
    amount,
    currency: "bdt", // the site prices everything in ৳
    contactNumber,
    deliveryAddress,
    notes: notes || "",
    createdAt: new Date(),
  };
  const result = await paymentsCollection.insertOne(payment);

  // The client redirects to /checkout?paymentId=… with this id.
  res.send({
    success: true,
    paymentId: String(result.insertedId),
    amount,
    currency: "bdt",
    days,
    units,
    quantity,
    equipmentName: equipment.name,
    message: "Booking confirmed — redirecting to payment",
  });
});

app.get("/api/ownerEquipment", async (req, res) => {
  const query = {};
  if (req.query) {
    query.ownerEmail = req.query.ownerEmail;
  }
  const result = await equipmentCollection.find(query).toArray();
  res.send(result);
});

app.get("/api/equipmentDetails/:id", async (req, res) => {
  const { id } = req.params;
  const result = await equipmentCollection.findOne({ _id: new ObjectId(id) });
  res.send(result);
});

// all equipment page public route api

app.get("/api/allEquipment", async (req, res) => {
  
  const query = {};
  if (req.query) {
    if (req.query.category) {
      query.category = req.query.category;
    }
    if (req.query.rentalType) {
      query.rentalType = req.query.rentalType;
    }
    if (req.query.rentalPrice) {
      query.rentalPrice = req.query.rentalPrice;
    }
    if (req.query.availableQuantity) {
      query.availableQuantity = req.query.availableQuantity;
    }
    if(req.query.status){
      query.status= req.query.status;
    }
    if (req.query.search) {
      query.$or = [
        { name: { $regex: req.query.search, $options: "i" } },
        { location: { $regex: req.query.search, $options: "i" } },
        { brand: { $regex: req.query.search, $options: "i" } },
      ];
    }
  }
  const result = await equipmentCollection.find(query).toArray();
  res.send(result);
});

app.delete("/api/deleteEquipment/:id", async (req, res) => {
  const { id } = req.params;
  const result = await equipmentCollection.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
});





// payment related api

// GET /api/payment/:id → one row of `payments` (pending or paid).
// The payment page (/checkout?paymentId=…) uses it to render the
// booking summary before the customer presses "Pay with Stripe".
app.get("/api/payment/:id", async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid payment id" });
  }
  const payment = await paymentsCollection.findOne({ _id: new ObjectId(id) });
  if (!payment) {
    return res.status(404).json({ success: false, message: "Payment not found" });
  }
  res.send(payment);
});

// Shape a booking the way the success page wants it: one flat object.
function toBookingSummary(booking) {
  return {
    success: true,
    bookingId: String(booking._id),
    equipmentName: booking.equipmentName,
    startDate: booking.startDate,
    endDate: booking.endDate,
    days: booking.days,
    quantity: booking.quantity,
    amount: booking.amount,
    currency: booking.currency,
    transactionId: booking.transactionId,
    customerEmail: booking.customerEmail,
  };
}

// POST /payment/checkout-verify  { sessionId }
//
// The success page calls this with the Stripe session it was redirected
// to. For a RENTAL BOOKING session (metadata.paymentId) it:
//   ① re-checks the session with Stripe — never trust the browser,
//   ② writes the transaction details onto the pending payment row,
//   ③ creates the booking record (only now, because only now is the
//      money actually there).
// Refreshing the success page is safe: an already-paid row returns the
// existing booking instead of creating a second one.
app.post("/payment/checkout-verify", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ success: false, message: "sessionId is required" });
  }

  // Ask Stripe whether this session was really paid.
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return res.send({ success: false, message: "Unknown checkout session" });
  }
  const { status, customer_email, metadata, payment_intent, payment_status } = session;

  if (status !== "complete" || payment_status !== "paid") {
    return res.send({ success: false, message: "Payment is not complete yet" });
  }

  const paymentId = metadata?.paymentId;

  // ── New flow: a rental booking payment (carries metadata.paymentId) ──
  if (paymentId && ObjectId.isValid(paymentId)) {
    const payment = await paymentsCollection.findOne({ _id: new ObjectId(paymentId) });
    if (!payment) {
      return res.send({ success: false, message: "Payment record not found" });
    }

    // Success page refreshed (or visited twice) → the booking already
    // exists, just show it again. Never insert it twice.
    if (payment.payment_status === "paid") {
      const existingBooking = await bookingsCollection.findOne({ paymentId: String(payment._id) });
      if (existingBooking) {
        return res.send(toBookingSummary(existingBooking));
      }
      return res.send({ success: false, message: "Payment verified but the booking is missing" });
    }

    // ② Save the transaction information on the payment record.
    await paymentsCollection.updateOne(
      { _id: payment._id },
      {
        $set: {
          payment_status: "paid",
          status,
          customer_email,
          sessionId,
          payment_intent,
          paidAt: new Date(),
        },
      }
    );

    // ③ Create the booking record — the payment has succeeded.
    const booking = {
      equipmentId: payment.equipmentId,
      equipmentName: payment.equipmentName,
      customerId: payment.userId,
      customerEmail: payment.customerEmail || customer_email,
      startDate: payment.startDate,
      endDate: payment.endDate,
      days: payment.days,
      quantity: payment.quantity,
      amount: payment.amount,
      currency: payment.currency,
      rentalType: payment.rentalType,
      unitPrice: payment.unitPrice,
      contactNumber: payment.contactNumber,
      deliveryAddress: payment.deliveryAddress,
      notes: payment.notes,
      // ← what the availability check in /api/prepareBooking looks for
      paymentStatus: "paid",
      paymentId: String(payment._id),
      sessionId,
      transactionId: payment_intent,
      bookingDate: new Date(),
      createdAt: new Date(),
    };
    const insertResult = await bookingsCollection.insertOne(booking);
    booking._id = insertResult.insertedId;

    return res.send(toBookingSummary(booking));
  }

  // ── Old plan payments (sessions created before this booking flow) ──
  const sessionQuery = { sessionId };
  const existingPayment = await paymentsCollection.findOne(sessionQuery);
  if (existingPayment) {
    return res.send({ success: false, message: "Payment already verified" });
  }

  const payment = {
    sessionId,
    status,
    customer_email,
    userId: metadata.userId,
    payment_intent,
    payment_status,
  };
  const result = await paymentsCollection.insertOne(payment);
  const query = { _id: new ObjectId(metadata.userId) };
  const updateResult = await usersCollection.updateOne(query, {
    $set: {
      premium: true,
    },
  });
  res.send({ success: true, result, updateResult });
});


// user related api

// GET /api/user/:id/premium  →  { premium: true | false }
//
// The "Book Equipment" button calls this to decide: pay first, or book
// straight away. Three bugs used to break it:
//   1. it read payments._id — but payments have their OWN _id and the
//      user id lives in the `userId` field, so findOne() always returned
//      null;
//   2. res.send(null) sends an EMPTY body → the client crashed with
//      "Unexpected end of JSON input" inside response.json();
//   3. a non-ObjectId id made new ObjectId(id) throw → 500, also empty.
app.get("/api/user/:id/premium", async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, message: "Invalid user id" });
  }

  // ① the flag /payment/checkout-verify sets on the user document
  const user = await usersCollection.findOne(
    { _id: new ObjectId(id) },
    { projection: { premium: 1 } }
  );

  // ② …or any payment already recorded for this user — covers payments
  //    that were verified before the premium flag was being saved.
  const payment = await paymentsCollection.findOne({ userId: id });

  // Always answer with JSON (never res.send(null)).
  res.json({ premium: user?.premium === true || Boolean(payment) });
});


// ────────────────────────────────────────────────────────────
// Customer Dashboard APIs
// ────────────────────────────────────────────────────────────

// GET /api/customerBookings?email=...
// Returns all bookings made by this customer
app.get("/api/customerBookings", async (req, res) => {
  try {
    const { email } = req.query;
    const query = {};
    if (email) {
      query.$or = [
        { customerEmail: { $regex: `^${email.trim()}$`, $options: "i" } },
        { email: { $regex: `^${email.trim()}$`, $options: "i" } },
        { customerId: email.trim() },
      ];
    }
    const result = await bookingsCollection
      .find(query)
      .sort({ bookingDate: -1, createdAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/customerFavourites?email=...
// Returns all saved favorite equipment for this customer
app.get("/api/customerFavourites", async (req, res) => {
  try {
    const { email } = req.query;
    const query = {};
    if (email) {
      query.$or = [
        { customerEmail: { $regex: `^${email.trim()}$`, $options: "i" } },
        { email: { $regex: `^${email.trim()}$`, $options: "i" } },
        { customerId: email.trim() },
      ];
    }
    const result = await favouriteCollection
      .find(query)
      .sort({ createdAt: -1, bookingDate: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/removeFavourite/:id
// Removes an item from the customer's favorites
app.delete("/api/removeFavourite/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let query = {};
    if (ObjectId.isValid(id)) {
      query = { $or: [{ _id: new ObjectId(id) }, { equipmentId: id }] };
    } else {
      query = { equipmentId: id };
    }
    const result = await favouriteCollection.deleteOne(query);
    res.send(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/user/profile?email=...
// Returns the profile information of the user
app.get("/api/user/profile", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }
    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    res.send(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/user/profile
// Updates the user profile details (name, image, phoneNumber, address)
app.put("/api/user/profile", async (req, res) => {
  try {
    const { email, name, image, phoneNumber, address } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }
    const updateDoc = {
      $set: {
        ...(name && { name }),
        ...(image && { image }),
        ...(phoneNumber !== undefined && { phoneNumber }),
        ...(address !== undefined && { address }),
        updatedAt: new Date(),
      },
    };
    const result = await usersCollection.updateOne({ email }, updateDoc);
    res.send({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ────────────────────────────────────────────────────────────
// Owner Dashboard APIs
// ────────────────────────────────────────────────────────────

// GET /api/ownerRentals?ownerEmail=...
// Returns all rental bookings made on the owner's equipment
app.get("/api/ownerRentals", async (req, res) => {
  try {
    const { ownerEmail } = req.query;
    if (!ownerEmail) {
      const allRentals = await bookingsCollection
        .find({})
        .sort({ bookingDate: -1, createdAt: -1 })
        .toArray();
      return res.send(allRentals);
    }

    // Find all equipment owned by this owner
    const equipments = await equipmentCollection
      .find({ ownerEmail: { $regex: `^${ownerEmail.trim()}$`, $options: "i" } })
      .toArray();
    const equipmentIds = equipments.map((e) => String(e._id));

    // Find bookings where equipmentId belongs to the owner OR ownerEmail matches
    const rentals = await bookingsCollection
      .find({
        $or: [
          { equipmentId: { $in: equipmentIds } },
          { ownerEmail: { $regex: `^${ownerEmail.trim()}$`, $options: "i" } },
        ],
      })
      .sort({ bookingDate: -1, createdAt: -1 })
      .toArray();

    res.send(rentals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ownerAnalytics?ownerEmail=... (Challenge 3: Owner Analytics)
app.get("/api/ownerAnalytics", async (req, res) => {
  try {
    const { ownerEmail } = req.query;
    if (!ownerEmail) {
      return res.status(400).json({ success: false, message: "ownerEmail is required" });
    }

    // 1. Total listed equipment
    const totalEquipment = await equipmentCollection.countDocuments({
      ownerEmail: { $regex: `^${ownerEmail.trim()}$`, $options: "i" },
    });

    // 2. Fetch owner equipment IDs to link bookings
    const equipments = await equipmentCollection
      .find({ ownerEmail: { $regex: `^${ownerEmail.trim()}$`, $options: "i" } })
      .toArray();
    const equipmentIds = equipments.map((e) => String(e._id));

    const bookings = await bookingsCollection
      .find({
        $or: [
          { equipmentId: { $in: equipmentIds } },
          { ownerEmail: { $regex: `^${ownerEmail.trim()}$`, $options: "i" } },
        ],
      })
      .toArray();

    // 3. Stats calculations
    const totalRentals = bookings.length;
    const completedRentals = bookings.filter((b) => b.bookingStatus === "completed").length;
    const activeRentals = bookings.filter(
      (b) => b.bookingStatus === "active" || (b.paymentStatus === "paid" && b.bookingStatus !== "completed")
    ).length;
    const totalEarnings = bookings
      .filter((b) => b.paymentStatus === "paid")
      .reduce((sum, b) => sum + (Number(b.amount) || 0), 0);

    // 4. Monthly earnings aggregation for charts
    const monthlyMap = {};
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${monthNames[d.getMonth()]}`;
      monthlyMap[key] = 0;
    }

    bookings.forEach((b) => {
      if (b.paymentStatus === "paid") {
        const d = b.bookingDate ? new Date(b.bookingDate) : new Date(b.createdAt || now);
        const key = `${monthNames[d.getMonth()]}`;
        if (monthlyMap[key] !== undefined) {
          monthlyMap[key] += Number(b.amount) || 0;
        } else {
          monthlyMap[key] = Number(b.amount) || 0;
        }
      }
    });

    const monthlyEarnings = Object.entries(monthlyMap).map(([month, earnings]) => ({
      month,
      earnings,
    }));

    res.send({
      success: true,
      totalEquipment,
      totalRentals,
      completedRentals,
      activeRentals,
      totalEarnings,
      monthlyEarnings,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/updateEquipment/:id
// Updates one equipment listing
app.put("/api/updateEquipment/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid equipment ID" });
    }
    const updateData = req.body;
    delete updateData._id;

    const result = await equipmentCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updateData, updatedAt: new Date() } }
    );
    res.send({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
