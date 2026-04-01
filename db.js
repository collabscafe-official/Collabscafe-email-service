const mongoose = require("mongoose");

let isConnected = false;

async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not defined in environment variables");

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  });

  isConnected = true;
  console.log("[DB] MongoDB connected");

  mongoose.connection.on("disconnected", () => {
    isConnected = false;
    console.warn("[DB] MongoDB disconnected");
  });

  mongoose.connection.on("error", (err) => {
    console.error("[DB] MongoDB error:", err.message);
  });
}

module.exports = { connectDB };
