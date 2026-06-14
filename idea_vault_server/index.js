require("dotenv").config();

const express = require("express");
const cors = require("cors");
const app = express();
const mongoUri = process.env.MONGO_DB_URI;
const PORT = process.env.PORT || 5000;
const cookieParser = require("cookie-parser");

// Middleware: কুকি, JSON বডি পার্সিং এবং CORS সেটিংস কনফিগারেশন
app.use(cookieParser());
app.use(express.json());
app.use((req, res, next) => {
  next();
});

// CORS Configuration: নির্দিষ্ট ডোমেইন থেকে রিকোয়েস্ট এক্সেস অনুমতি দেয়
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// JWT Token Verification Setup: জেসন ওয়েব টোকেন ভেরিফিকেশন এবং ডাটাবেজ ক্লায়েন্ট সেটআপ
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const client = new MongoClient(mongoUri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// JWK Token URL: Better Auth থেকে আসা টোকেন ভেরিফাই করার জন্য পাবলিক কী সেটআপ
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL || "http://localhost:3000"}/api/auth/jwks`),
);

// Middleware: রিকোয়েস্টের হেডার বা কুকি থেকে টোকেন নিয়ে ইউজার ভেরিফাই করে
const verifyToken = async (req, res, next) => {
  let token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    token = req.cookies?.["better-auth.session_token"];
  }

  const clientLoginUrl = `${process.env.CLIENT_URL || "http://localhost:3000"}/login`;

  if (!token) {
    return res.redirect(clientLoginUrl);
  }

  try {
    try {
      const { payload } = await jwtVerify(token, JWKS);
      req.user = { id: payload.sub, _id: payload.sub, ...payload };
      return next();
    } catch (jwtError) {
      // JWT ভেরিফিকেশন ফেইল হলে ডাটাবেজের সেশন থেকে ভেরিফাই করার চেষ্টা
      const db = client.db("IdeaVault");
      const session = await db.collection("session").findOne({ token: token });

      if (!session) {
        return res.redirect(clientLoginUrl);
      }

      const user = await db.collection("user").findOne({ id: session.userId });

      if (!user) {
        try {
          const userByObjId = await db
            .collection("user")
            .findOne({ _id: new ObjectId(session.userId) });
          if (userByObjId) {
            req.user = userByObjId;
            return next();
          }
        } catch (e) {}

        console.error("User not found for userId:", session.userId);
        return res.redirect(clientLoginUrl);
      }

      req.user = user;
      next();
    }
  } catch (error) {
    console.error("Verification Error:", error);
    res.redirect(clientLoginUrl);
  }
};

// Main Server Function: ডাটাবেজ কানেকশন এবং সকল API এন্ডপয়েন্ট হ্যান্ডলিং
async function run() {
  try {
    const db = client.db("IdeaVault");
    // ডাটাবেজ কালেকশন রেফারেন্স
    const dataBaseCollection = db.collection("IdeaVaults");
    const bookingCollection = db.collection("bookings");
    const commentCollection = db.collection("comments");
    const activitiesCollection = db.collection("activities");

    // ==========================================
    // IDEA ROUTES: আইডিয়া তৈরি, পড়া, আপডেট এবং মুছে ফেলার এন্ডপয়েন্ট
    // ==========================================

    app.post("/api/idea", verifyToken, async (req, res) => {
      try {
        const { userId, ...formData } = req.body;
        const currentUserId = req.user.id || req.user._id;

        const newIdea = {
          ...formData,
          userId: currentUserId,
          createdAt: new Date(),
        };

        const result = await dataBaseCollection.insertOne(newIdea);
        res.status(201).json(result);
      } catch (error) {
        console.error("Error creating idea:", error);
        res.status(500).json({ error: "Failed to create idea" });
      }
    });

    app.get("/api/idea", async (req, res) => {
      try {
        const category = req.query.category || "";
        const search = req.query.search || "";
        const userId = req.query.userId || null;

        let query = {};

        if (userId) query.userId = userId;
        if (category && category !== "All") query.category = category;

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { ideaTitle: { $regex: search, $options: "i" } },
            { content: { $regex: search, $options: "i" } },
            { shortDescription: { $regex: search, $options: "i" } },
          ];
        }

        const result = await dataBaseCollection.find(query).toArray();
        res.json(result);
      } catch (error) {
        console.error("Fetch ideas error:", error);
        res.status(500).json({ error: "Failed to fetch ideas" });
      }
    });

    app.get("/api/idea/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id))
          return res.status(400).json({ error: "Invalid ID format" });

        const result = await dataBaseCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!result) return res.status(404).json({ error: "Idea not found" });

        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    app.patch("/api/idea/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id))
          return res.status(400).json({ error: "Invalid ID format" });

        const updatedData = req.body;
        const result = await dataBaseCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData },
        );

        if (result.matchedCount === 0)
          return res.status(404).json({ error: "Idea not found" });
        res.json({ message: "Idea updated successfully", result });
      } catch (error) {
        res.status(500).json({ error: "Failed to update idea" });
      }
    });

    app.delete("/api/idea/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id))
          return res.status(400).json({ error: "Invalid ID format" });

        const result = await dataBaseCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount === 0)
          return res.status(404).json({ error: "Idea not found" });

        res.json({ message: "Idea deleted successfully", result });
      } catch (error) {
        res.status(500).json({ error: "Failed to delete idea" });
      }
    });

    // ==========================================
    // ACTIVITY ROUTES: ইউজারের কার্যক্রম ট্র্যাক এবং ডিলিট করার এন্ডপয়েন্ট
    // ==========================================

    app.get("/api/activity", verifyToken, async (req, res) => {
      try {
        const userId = req.user.sub || req.user.id || req.user._id?.toString();
        const result = await activitiesCollection
          .find({ userId: userId })
          .toArray();
        res.json(result);
      } catch (error) {
        console.error("Fetch activities error:", error);
        res.status(500).json({ error: "Failed to fetch activities" });
      }
    });

    app.delete("/api/activity/:id", verifyToken, async (req, res) => {
      try {
        const activityId = req.params.id;
        const userId = req.user.sub || req.user.id || req.user._id?.toString();

        if (!ObjectId.isValid(activityId))
          return res.status(400).json({ error: "Invalid ID format" });

        const result = await activitiesCollection.deleteOne({
          _id: new ObjectId(activityId),
          userId: userId,
        });

        res.json(result);
      } catch (error) {
        console.error("Error deleting activity:", error);
        res.status(500).json({ error: "Failed to delete activity" });
      }
    });

    // ==========================================
    // BOOKING ROUTES: বুকিং সম্পর্কিত ডাটা অপারেশন
    // ==========================================

    app.get("/api/bookings", async (req, res) => {
      try {
        const result = await bookingCollection.find({}).toArray();
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch bookings" });
      }
    });

    app.post("/api/bookings", async (req, res) => {
      try {
        const bookingData = req.body;
        const result = await bookingCollection.insertOne(bookingData);
        res.status(201).json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to create booking" });
      }
    });

    // ==========================================
    // COMMENT ROUTES: কমেন্ট করা, আপডেট, ডিলিট এবং কার্যক্রম লগ করা
    // ==========================================

    app.get("/api/comments", async (req, res) => {
      try {
        const result = await commentCollection.find({}).toArray();
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to fetch comments" });
      }
    });

    app.post("/api/comments", verifyToken, async (req, res) => {
      try {
        const userId = req.user.sub || req.user.id || req.user._id?.toString();
        const commentData = { ...req.body, userId: userId };
        const result = await commentCollection.insertOne(commentData);

        // কমেন্ট করার পর অ্যাক্টিভিটি লগে ডাটা সেভ
        await activitiesCollection.insertOne({
          userId: userId,
          action: "Posted a new comment",
          details: { text: req.body.text },
          timestamp: new Date(),
        });

        res.status(201).json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to create comment" });
      }
    });

    app.patch("/api/comments/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userId = req.user.sub || req.user.id || req.user._id?.toString();
        const updatedData = req.body;

        const result = await commentCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { text: updatedData.text, time: updatedData.time } },
        );

        // কমেন্ট আপডেটের পর অ্যাক্টিভিটি লগে ডাটা সেভ
        await activitiesCollection.insertOne({
          userId: userId,
          action: "Updated a comment",
          details: { text: updatedData.text },
          timestamp: new Date(),
        });

        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to update comment" });
      }
    });

    app.delete("/api/comments/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userId = req.user.sub || req.user.id || req.user._id?.toString();

        const commentToDelete = await commentCollection.findOne({
          _id: new ObjectId(id),
        });
        const result = await commentCollection.deleteOne({
          _id: new ObjectId(id),
        });

        // কমেন্ট ডিলিটের পর অ্যাক্টিভিটি লগে ডাটা সেভ
        if (result.deletedCount > 0) {
          await activitiesCollection.insertOne({
            userId: userId,
            action: "Deleted a comment",
            details: { text: commentToDelete?.text || "Unknown comment" },
            timestamp: new Date(),
          });
        }

        res.json(result);
      } catch (error) {
        res.status(500).json({ error: "Failed to delete comment" });
      }
    });

    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } catch (error) {
    console.error("Database connection failed:", error);
  }
}

run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
  res.send("Server is running and Database is ready!");
});

// Server listener
app.listen(PORT, () => {
  console.log(`Server is running on Port ${PORT}`);
});
