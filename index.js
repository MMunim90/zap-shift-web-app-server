const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.actwx8z.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking");
    const usersCollection = db.collection("users");
    const riderApplicationsCollection = db.collection("riderApplications");

    // custom middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      //verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // post be a rider application
    app.post("/riderApplications", verifyFBToken, async (req, res) => {
      try {
        const {
          name,
          email,
          age,
          region,
          district,
          phone,
          nid,
          nidImage,
          bikeImage,
          bikeBrand,
          bikeRegNumber,
          additionalInfo,
        } = req.body;

        const newApplication = {
          name,
          email,
          age: Number(age),
          region,
          district,
          phone,
          nid,
          nidImage,
          bikeImage,
          bikeBrand,
          bikeRegNumber,
          additionalInfo: additionalInfo || "",
          status: "pending",
          createdAt: new Date(),
        };

        const result = await riderApplicationsCollection.insertOne(
          newApplication
        );
        res.status(201).json({ insertedId: result.insertedId });
      } catch (error) {
        console.error("Error submitting rider application:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    app.get("/riderApplications/pending", verifyFBToken, async (req, res) => {
      try {
        const pendingRiders = await riderApplicationsCollection
          .find({ status: "pending" })
          .sort({ createdAt: -1 }) // newest first
          .toArray();

        res.send(pendingRiders);
      } catch (error) {
        console.error("Failed to fetch pending riders:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // approved rider
    app.patch(
      "/riderApplications/status/:id",
      verifyFBToken,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;

        if (!["approved", "rejected"].includes(status)) {
          return res.status(400).json({ message: "Invalid status value" });
        }

        try {
          const result = await riderApplicationsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );

          if (result.modifiedCount === 0) {
            return res
              .status(404)
              .json({ message: "Application not found or already updated" });
          }

          res.json({ message: "Status updated successfully" });
        } catch (error) {
          console.error("Failed to update rider status:", error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    // reject rider
    app.delete("/riderApplications/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;

      try {
        const result = await riderApplicationsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ message: "Application not found" });
        }

        res.json({ message: "Application deleted successfully" });
      } catch (error) {
        console.error("Failed to delete rider application:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });
      if (userExists) {
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }

      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get("/parcels", async (req, res) => {
      const email = req.query.email;

      const query = { email: email };
      const parcels = await parcelsCollection.find(query).toArray();
      res.send(parcels);
    });

    // get parcels api
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { email: userEmail } : {};
        const sort = { _id: -1 }; // latest first

        const parcels = await parcelsCollection
          .find(query)
          .sort(sort)
          .toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to fetch parcels" });
      }
    });

    // get a specific parcel by Id
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };
        const parcel = await parcelsCollection.findOne(query);

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel by ID:", error);
        res.status(500).send({ message: "Failed to get parcel" });
      }
    });

    // POST: Add a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelsCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res.status(500).send({ message: "Failed to add parcel" });
      }
    });

    // DELETE a parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      const { id } = req.params;
      try {
        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 1) {
          res
            .status(200)
            .send({ success: true, message: "Parcel deleted successfully" });
        } else {
          res.status(404).send({ success: false, message: "Parcel not found" });
        }
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res
          .status(500)
          .send({ success: false, message: "Failed to delete parcel" });
      }
    });

    // post tracking parcel
    app.post("/tracking", async (req, res) => {
      try {
        const { trackingId, parcelId, status, location } = req.body;

        if (!trackingId || !parcelId || !status || !location) {
          return res.status(400).send({ message: "Missing tracking data" });
        }

        const entry = {
          tracking_id: trackingId,
          parcelId: new ObjectId(parcelId),
          status,
          location,
          timestamp: new Date(),
        };

        const result = await trackingCollection.insertOne(entry);
        res.send({ message: "Tracking update saved", result });
      } catch (error) {
        console.error("Tracking insert error:", error);
        res.status(500).send({ message: "Failed to add tracking update" });
      }
    });

    // Get all tracking updates for a tracking ID (latest first)
    app.get("/tracking/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;

      const updates = await trackingCollection
        .findOne({ tracking_id: trackingId })
        .sort({ timestamp: -1 })
        .toArray();

      if (!updates.length) {
        return res.status(404).send({ message: "No tracking updates found" });
      }

      res.send(updates);
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      console.log("headers in payments", req.headers);
      try {
        const userEmail = req.query.email;

        console.log("decoded", req.decoded);
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "forbidden access" });
        }

        const query = userEmail ? { email: userEmail } : {};
        const sort = { paid_at: -1 }; // Latest first

        const payments = await paymentsCollection
          .find(query)
          .sort(sort)
          .toArray();
        res.send(payments);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ message: "Failed to load payment history" });
      }
    });

    // record payment and update parcel status
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, transactionId, paymentMethod } =
          req.body;

        const parcelObjectId = new ObjectId(parcelId);

        // 1. Update the parcel document with payment info
        const updateResult = await parcelsCollection.updateOne(
          { _id: parcelObjectId },
          {
            $set: {
              payment_status: "paid",
              paid_at: new Date(),
            },
          }
        );

        // 2. Create a new payment history entry
        const paymentEntry = {
          parcelId: parcelObjectId,
          email,
          amount,
          transactionId,
          paymentMethod, // e.g. "card", "bkash", etc.
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const insertResult = await paymentsCollection.insertOne(paymentEntry);

        res.send({
          message: "Payment processed and recorded",
          updateResult,
          insertResult,
        });
      } catch (error) {
        console.error("Payment processing error:", error);
        res.status(500).send({ message: "Failed to process payment" });
      }
    });

    // payment intent
    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents, // Amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Basic route
app.get("/", (req, res) => {
  res.send("Parcel Delivery Server is Running");
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
