require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { connectDB } = require("./db");
const { startQueue } = require("./services/queue.service");
const campaignRoutes = require("./routes/campaign.routes");
const statusRoutes = require("./routes/status.routes");

const app = express();
const PORT = process.env.PORT || 4000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use(limiter);

// ── Routes ────────────────────────────────────────────────────────────────────

app.use("/campaigns", campaignRoutes);
app.use("/", statusRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("[Error]", err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  try {
    await connectDB();
    startQueue();

    app.listen(PORT, () => {
      console.log(`[Server] collabscafe-email-service running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[Server] Failed to start:", err.message);
    process.exit(1);
  }
}

start();
