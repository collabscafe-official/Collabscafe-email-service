const mongoose = require("mongoose");
const Campaign = require("../models/Campaign");
const EmailLog = require("../models/EmailLog");

// GET /health
async function health(req, res) {
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? "connected" : "disconnected";

  res.json({
    status: "ok",
    db: dbStatus,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

// GET /status
async function getStats(req, res) {
  const [
    totalCampaigns,
    runningCampaigns,
    completedCampaigns,
    totalEmailsSent,
    totalEmailsFailed,
    totalEmailsPending,
  ] = await Promise.all([
    Campaign.countDocuments(),
    Campaign.countDocuments({ status: "running" }),
    Campaign.countDocuments({ status: "completed" }),
    EmailLog.countDocuments({ status: "sent" }),
    EmailLog.countDocuments({ status: "failed" }),
    EmailLog.countDocuments({ status: "pending" }),
  ]);

  res.json({
    campaigns: {
      total: totalCampaigns,
      running: runningCampaigns,
      completed: completedCampaigns,
    },
    emails: {
      sent: totalEmailsSent,
      failed: totalEmailsFailed,
      pending: totalEmailsPending,
    },
  });
}

module.exports = { health, getStats };
