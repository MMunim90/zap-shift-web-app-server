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

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decodedKey);

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
    // await client.connect();

    const db = client.db("parcelDB");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking");
    const usersCollection = db.collection("users");
    const riderApplicationsCollection = db.collection("riderApplications");

    // custom middlewares

    // verify firebase token
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      const token = authHeader.split(" ")[1];
      console.log(token)
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

    // verify admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // verify rider
    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // dashboard get route for rider
    app.get("/parcels/delivery/status-count", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$delivery_status",
            count: {
              $sum: 1,
            },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];

      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    // api for user and rider for now
    app.get("/stats", async (req, res) => {
      try {
        const { role, email } = req.query;

        if (!role || !email) {
          return res.status(400).json({ error: "Missing role or email" });
        }

        let query = {};

        if (role === "user") {
          query.email = email;
        } else if (role === "rider") {
          query.assigned_rider = email;
        } else {
          return res.status(400).json({ error: "Invalid role" });
        }

        const totalParcels = await parcelsCollection.countDocuments(query);

        const deliveredParcels = await parcelsCollection.countDocuments({
          ...query,
          delivery_status: "delivered",
        });

        const pendingParcels = await parcelsCollection.countDocuments({
          ...query,
          delivery_status: { $ne: "delivered" },
        });

        const deliveredDocsCursor = await parcelsCollection.find({
          ...query,
          delivery_status: "delivered",
        });

        const deliveredDocs = await deliveredDocsCursor.toArray();

        let earnings = 0;
        let cashedOut = 0;

        for (const parcel of deliveredDocs) {
          const isSameDistrict = parcel.senderRegion === parcel.receiverRegion;
          const rate = isSameDistrict ? 0.9 : 0.3;
          const amount = Number(parcel.total_cost) * rate;

          earnings += amount;

          if (parcel.isCashedOut) {
            cashedOut += amount;
          }
        }

        res.json({
          totalParcels,
          deliveredParcels,
          pendingParcels,
          earnings: parseFloat(earnings.toFixed(2)),
          cashedOut: parseFloat(cashedOut.toFixed(2)),
        });
      } catch (err) {
        console.error("Stats error:", err);
        res.status(500).json({ error: "Failed to fetch stats" });
      }
    });

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

        // Step 1: Check if an application already exists
        const existingApplication = await riderApplicationsCollection.findOne({
          email,
          status: { $in: ["pending", "approved"] },
        });

        if (existingApplication) {
          return res.status(409).json({
            message: "You have already submitted an application.",
          });
        }

        // Step 2: Proceed to insert new application
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

    app.get(
      "/riderApplications/pending",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
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
      }
    );

    // getting approved rider
    app.get(
      "/riderApplications/approved",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const approvedRiders = await riderApplicationsCollection
            .find({ status: "approved" })
            .sort({ createdAt: -1 }) // optional: latest first
            .toArray();

          res.send(approvedRiders);
        } catch (error) {
          console.error("Error fetching approved riders:", error);
          res.status(500).send({ message: "Failed to fetch approved riders" });
        }
      }
    );

    // approved rider
    app.patch(
      "/riderApplications/status/:id",
      verifyFBToken,
      async (req, res) => {
        const { id } = req.params;
        const { status, email } = req.body;

        if (!["approved", "rejected", "inactive"].includes(status)) {
          return res.status(400).json({ message: "Invalid status value" });
        }

        try {
          const result = await riderApplicationsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );

          // update user role for accepting rider
          if (status === "approved") {
            const useQuery = { email };
            const userUpdateDoc = {
              $set: {
                role: "rider",
              },
            };
            const roleResult = await usersCollection.updateOne(
              useQuery,
              userUpdateDoc
            );
            console.log(roleResult.modifiedCount);
          }

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
    app.delete(
      "/riderApplications/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
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
      }
    );

    app.get("/riderApplications/:email", async (req, res) => {
      const email = req.params.email;

      const existing = await riderApplicationsCollection.findOne({
        email,
        status: { $in: ["pending", "approved"] },
      });

      res.json({ exists: !!existing });
    });

    // GET /users/search?email=user@example.com
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).send({ message: "Email required" });

      const regex = new RegExp(email, "i"); // case-insensitive partial match

      try {
        const users = await usersCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, createdAt: 1, role: 1 })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (error) {
        console.error("Error searching users:", error);
        res.status(500).send({ message: "Error searching users" });
      }
    });

    // make admin
    app.patch(
      "/users/admin/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { role } = req.body;

        if (!["admin", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalid role" });
        }

        const requesterEmail = req.decoded?.email;

        // Optional: Check if requester is admin before allowing the update
        const requester = await usersCollection.findOne({
          email: requesterEmail,
        });

        if (requester?.role !== "admin") {
          return res
            .status(403)
            .send({ message: "Only admins can update roles" });
        }

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { role } }
          );

          if (result.modifiedCount === 0) {
            return res
              .status(404)
              .send({ message: "User not found or role unchanged" });
          }

          res.send({ message: "Role updated successfully", result });
        } catch (error) {
          console.error("Error updating user role:", error);
          res.status(500).send({ message: "Error updating user role" });
        }
      }
    );

    // find user role
    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      try {
        const user = await usersCollection.findOne(
          { email },
          { projection: { role: 1 } } // Only fetch the role field
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role || "user" }); // Default to "user" if no role
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.status(500).send({ message: "Server error" });
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

    // GET /riders?district=SomeDistrict
    app.get("/riders", async (req, res) => {
      try {
        const { senderArea } = req.query;

        if (!senderArea) {
          return res.status(400).send({ message: "senderArea is required" });
        }

        // Assuming 'district' field in riderApplications matches the parcel's senderArea
        const riders = await riderApplicationsCollection
          .find({
            district: senderArea,
            status: "approved",
          })
          .project({
            name: 1,
            email: 1,
            district: 1,
            phone: 1,
            bikeBrand: 1,
            work_status: 1,
          }) // optional projection
          .toArray();

        res.send(riders);
      } catch (error) {
        console.error("Error fetching riders:", error);
        res.status(500).send({ message: "Failed to fetch riders" });
      }
    });

    app.patch("/assign-rider", async (req, res) => {
      try {
        const { parcelId, riderId, riderEmail, riderName } = req.body;

        if (!parcelId || !riderEmail) {
          return res
            .status(400)
            .send({ message: "parcelId and riderEmail are required" });
        }

        // 1. Check rider work_status
        const rider = await riderApplicationsCollection.findOne({
          email: riderEmail,
        });

        if (!rider) {
          return res.status(404).send({ message: "Rider not found" });
        }

        if (rider.work_status === "in-delivery") {
          return res
            .status(403)
            .send({ message: "Rider is already on a delivery" });
        }

        // 2. Update parcel delivery_status
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: "rider_assigned",
              assigned_rider_id: riderId,
              assigned_rider: riderEmail,
              assigned_rider_name: riderName,
            },
          }
        );

        // 3. Update rider's work_status
        const riderUpdate = await riderApplicationsCollection.updateOne(
          { email: riderEmail },
          {
            $set: {
              work_status: "in-delivery",
            },
          }
        );

        if (
          parcelUpdate.modifiedCount === 0 ||
          riderUpdate.modifiedCount === 0
        ) {
          return res.status(404).send({ message: "Update failed" });
        }

        res.send({ message: "Rider assigned successfully" });
      } catch (error) {
        console.error("Assignment Error:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // get parcels api
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { email, payment_status, delivery_status } = req.query;

        const query = {};

        if (email) query.email = email;
        if (payment_status) query.payment_status = payment_status;
        if (delivery_status) query.delivery_status = delivery_status;

        // console.log('parcel query', req.query, query)
        const parcels = await parcelsCollection
          .find(query)
          .sort({ _id: -1 }) // latest first
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
        const {
          tracking_id,
          parcel_id, // optional
          status,
          details, // optional free‑text
          location,
          updated_by,
        } = req.body;

        // basic validation
        if (!tracking_id || !status || !location || !updated_by) {
          return res.status(400).send({ message: "Missing tracking data" });
        }

        // build the document
        const entry = {
          tracking_id,
          status,
          location,
          updated_by,
          timestamp: new Date(),
        };

        // add optional fields only if supplied
        if (parcel_id) entry.parcel_id = new ObjectId(parcel_id);
        if (details) entry.details = details;

        // insert into MongoDB
        const result = await trackingCollection.insertOne(entry);

        res.send({
          message: "Tracking update saved",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Tracking insert error:", error);
        res.status(500).send({ message: "Failed to add tracking update" });
      }
    });

    // Get all tracking updates for a tracking ID (latest first)
    app.get("/tracking/:trackingId", async (req, res) => {
      const trackingId = (req.params.trackingId || "").toUpperCase();

      try {
        const updates = await trackingCollection
          .find({ tracking_id: trackingId })
          .sort({ timestamp: -1 })
          .toArray();

        if (!updates.length) {
          return res.status(404).send({ message: "No tracking updates found" });
        }

        res.send(updates);
      } catch (error) {
        console.error("Error fetching tracking updates:", error);
        res
          .status(500)
          .send({ message: "Internal Server Error", error: error.message });
      }
    });

    // rider pending parcel get api
    app.get(
      "/rider/pending-deliveries",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const riderEmail = req.query.riderEmail || req.decoded?.email;

          if (!riderEmail) {
            return res.status(400).send({ message: "Rider email is required" });
          }

          const query = {
            assigned_rider: riderEmail,
            delivery_status: { $in: ["rider_assigned", "in_transit"] },
          };

          const options = {
            sort: {
              creation_date: -1,
            },
          };

          const pendingParcels = await parcelsCollection
            .find(query, options)
            .toArray();

          res.send(pendingParcels);
        } catch (error) {
          console.error("Error fetching rider's pending parcels:", error);
          res.status(500).send({ message: "Failed to fetch pending parcels" });
        }
      }
    );

    // rider pending parcel patch api
    app.patch("/parcels/:parcelId/update-status", async (req, res) => {
      try {
        const { parcelId } = req.params;
        const { delivery_status } = req.body;

        if (!delivery_status) {
          return res
            .status(400)
            .send({ message: "delivery_status is required" });
        }

        // 1. Find the parcel to get the rider info
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        const riderEmail = parcel.assigned_rider;

        // 2. Update the parcel delivery status
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status,
              updatedAt: new Date(),
            },
          }
        );

        // 3. If marked as delivered → update rider's work_status to available
        let riderUpdate = null;
        if (delivery_status === "delivered" && riderEmail) {
          riderUpdate = await riderApplicationsCollection.updateOne(
            { email: riderEmail },
            { $set: { work_status: "available" } }
          );
        }

        res.send({
          message: "Parcel status updated",
          parcelModified: parcelUpdate.modifiedCount,
          riderUpdated: riderUpdate?.modifiedCount || 0,
        });
      } catch (error) {
        console.error("Status update error:", error);
        res.status(500).send({ message: "Failed to update status" });
      }
    });

    // rider completed parcel get api
    app.get(
      "/rider/completed-deliveries",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const riderEmail = req.decoded.email;

          if (!riderEmail) {
            return res.status(400).send({ message: "Rider email is required" });
          }

          const query = {
            assigned_rider: riderEmail,
            delivery_status: { $in: ["delivered", "service_center_delivered"] },
          };

          const options = {
            sort: { creation_date: -1 }, // Newest first
          };

          const completedParcels = await parcelsCollection
            .find(query, options)
            .toArray();

          res.send(completedParcels);
        } catch (error) {
          console.error("Error fetching completed deliveries:", error);
          res
            .status(500)
            .send({ message: "Failed to fetch completed deliveries" });
        }
      }
    );

    // rider cashout api
    app.patch("/rider/cashout/:parcelId", verifyFBToken, async (req, res) => {
      const { parcelId } = req.params;
      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { isCashedOut: true, cashedOutAt: new Date() } }
        );

        if (result.modifiedCount > 0) {
          res.send({ success: true });
        } else {
          res
            .status(404)
            .send({ message: "Parcel not found or already cashed out" });
        }
      } catch (error) {
        console.error("Cashout error:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
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
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
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
