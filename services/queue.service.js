const Campaign = require("../models/Campaign");
const EmailLog = require("../models/EmailLog");
const Influencer = require("../models/Influencer");
const { sendEmail } = require("./ses.service");
const { renderForCampaign } = require("./template.service");

const BATCH_SIZE = parseInt(process.env.QUEUE_BATCH_SIZE) || 50;
const INTERVAL_MS = parseInt(process.env.QUEUE_INTERVAL_MS) || 5000;

let timer = null;
let isProcessing = false;

function startQueue() {
  if (timer) return;
  timer = setInterval(processBatch, INTERVAL_MS);
  console.log(`[Queue] Started — batch size: ${BATCH_SIZE}, interval: ${INTERVAL_MS}ms`);
}

function stopQueue() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[Queue] Stopped");
  }
}

/**
 * Enqueue all matching influencers for a campaign.
 * Called once when a campaign is triggered.
 */
async function enqueueCampaign(campaign) {
  let influencers = await buildAudience(campaign.targetFilters);

  // Filter out explicitly excluded influencers
  if (campaign.excludedIds && campaign.excludedIds.length > 0) {
    const excludedSet = new Set(campaign.excludedIds.map((id) => String(id)));
    influencers = influencers.filter((inf) => !excludedSet.has(String(inf._id)));
  }

  if (influencers.length === 0) {
    await Campaign.findByIdAndUpdate(campaign._id, {
      status: "completed",
      totalTargeted: 0,
      completedAt: new Date(),
    });
    return 0;
  }

  // Bulk-insert pending logs (skip duplicates via upsert)
  const ops = influencers.map((inf) => ({
    updateOne: {
      filter: { campaignId: campaign._id, influencerId: inf._id },
      update: {
        $setOnInsert: {
          campaignId: campaign._id,
          influencerId: inf._id,
          email: inf.email,
          status: "pending",
        },
      },
      upsert: true,
    },
  }));

  await EmailLog.bulkWrite(ops, { ordered: false });

  await Campaign.findByIdAndUpdate(campaign._id, {
    status: "running",
    totalTargeted: influencers.length,
    startedAt: new Date(),
  });

  console.log(`[Queue] Campaign ${campaign._id} enqueued ${influencers.length} recipients`);
  return influencers.length;
}

async function processBatch() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Pick pending logs in FIFO order
    const logs = await EmailLog.find({ status: "pending" })
      .sort({ createdAt: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (logs.length === 0) {
      isProcessing = false;
      return;
    }

    console.log(`[Queue] Processing ${logs.length} emails`);

    for (const log of logs) {
      await processOne(log);
    }

    // Check if any campaigns are now fully complete
    await resolveCompletedCampaigns();
  } catch (err) {
    console.error("[Queue] Batch error:", err.message);
  } finally {
    isProcessing = false;
  }
}

async function processOne(log) {
  try {
    const [campaign, influencer] = await Promise.all([
      Campaign.findById(log.campaignId).lean(),
      Influencer.findById(log.influencerId).lean(),
    ]);

    if (!campaign || !influencer || !influencer.email) {
      await EmailLog.findByIdAndUpdate(log._id, {
        status: "failed",
        errorMessage: !campaign ? "Campaign not found" : "Influencer missing or has no email",
      });
      return;
    }

    const htmlBody = renderForCampaign(campaign, influencer);
    const messageId = await sendEmail({
      to: influencer.email,
      subject: campaign.subject,
      htmlBody,
    });

    await EmailLog.findByIdAndUpdate(log._id, {
      status: "sent",
      messageId,
      sentAt: new Date(),
    });

    await Campaign.findByIdAndUpdate(log.campaignId, { $inc: { sentCount: 1 } });
  } catch (err) {
    await EmailLog.findByIdAndUpdate(log._id, {
      status: "failed",
      errorMessage: err.message,
    });
    await Campaign.findByIdAndUpdate(log.campaignId, { $inc: { failedCount: 1 } });
    console.error(`[Queue] Email failed for log ${log._id}:`, err.message);
  }
}

async function resolveCompletedCampaigns() {
  // Find running campaigns with no remaining pending logs
  const running = await Campaign.find({ status: "running" }).select("_id").lean();

  for (const c of running) {
    const pendingCount = await EmailLog.countDocuments({ campaignId: c._id, status: "pending" });
    if (pendingCount === 0) {
      await Campaign.findByIdAndUpdate(c._id, {
        status: "completed",
        completedAt: new Date(),
      });
      console.log(`[Queue] Campaign ${c._id} completed`);
    }
  }
}

// ── Audience builder ─────────────────────────────────────────────────────────

async function buildAudience(filters = {}) {
  const query = { email: { $exists: true, $ne: "" } };

  if (filters.platform) {
    query["social_handles.platform"] = filters.platform.toLowerCase();
  }
  if (filters.country) {
    query.country = new RegExp(`^${filters.country}$`, "i");
  }
  if (filters.city) {
    query.city = new RegExp(`^${filters.city}$`, "i");
  }
  if (filters.emailVerified !== null && filters.emailVerified !== undefined) {
    query.email_verified = filters.emailVerified;
  }
  if (filters.profileCompleted !== null && filters.profileCompleted !== undefined) {
    query.profile_completed = filters.profileCompleted;
  }
  if (filters.inactiveDays && filters.inactiveDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - filters.inactiveDays);
    query.last_active = { $lt: cutoff };
  }
  if (filters.minFollowers > 0 || filters.maxFollowers > 0) {
    const followersFilter = {};
    if (filters.minFollowers > 0) followersFilter.$gte = filters.minFollowers;
    if (filters.maxFollowers > 0) followersFilter.$lte = filters.maxFollowers;
    query["social_handles.followers"] = followersFilter;
  }

  return Influencer.find(query).select("_id name username email city country").lean();
}

module.exports = { startQueue, stopQueue, enqueueCampaign };
