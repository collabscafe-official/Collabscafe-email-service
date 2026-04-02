const Campaign = require("../models/Campaign");
const EmailLog = require("../models/EmailLog");
const Influencer = require("../models/Influencer");
const { sendEmail } = require("./ses.service");
const { renderForCampaign } = require("./template.service");

// campaignId (string) → setTimeout handle
const activeTimers = new Map();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a campaign: build audience, create pending logs, begin timer chain.
 * Called by sendCampaign controller after resetting counters.
 */
async function startCampaign(campaign) {
  const count = await enqueueCampaign(campaign);
  if (count === 0) return 0;

  const delayMs = rateToDelayMs(campaign.ratePerHour);
  scheduleNext(String(campaign._id), delayMs);
  return count;
}

/**
 * Pause a running campaign. Clears the in-process timer; pending logs stay pending.
 */
async function pauseCampaign(campaignId) {
  const id = String(campaignId);
  clearTimer(id);

  await Campaign.findByIdAndUpdate(campaignId, {
    status: "paused",
    pausedAt: new Date(),
  });

  console.log(`[Queue] Campaign ${id} paused`);
}

/**
 * Resume a paused campaign. Restarts the timer chain from where it left off.
 */
async function resumeCampaign(campaignId) {
  const campaign = await Campaign.findByIdAndUpdate(
    campaignId,
    { status: "running", pausedAt: null },
    { new: true }
  ).lean();

  if (!campaign) return;

  const delayMs = rateToDelayMs(campaign.ratePerHour);
  scheduleNext(String(campaignId), delayMs);
  console.log(`[Queue] Campaign ${campaignId} resumed`);
}

/**
 * Stop a campaign permanently. Cancels all pending logs.
 */
async function stopCampaign(campaignId) {
  const id = String(campaignId);
  clearTimer(id);

  await Campaign.findByIdAndUpdate(campaignId, {
    status: "cancelled",
    stoppedAt: new Date(),
  });

  await EmailLog.updateMany(
    { campaignId, status: "pending" },
    { status: "cancelled" }
  );

  console.log(`[Queue] Campaign ${id} stopped and cancelled`);
}

/**
 * Called on server start. Resumes any campaigns that were mid-send when
 * the server shut down (status still "running").
 */
async function restoreRunningCampaigns() {
  const running = await Campaign.find({ status: "running" }).lean();
  if (running.length === 0) return;

  console.log(`[Queue] Restoring ${running.length} running campaign(s)...`);
  for (const campaign of running) {
    const delayMs = rateToDelayMs(campaign.ratePerHour);
    scheduleNext(String(campaign._id), delayMs);
    console.log(`[Queue] Restored campaign ${campaign._id}`);
  }
}

// ── Internal timer chain ──────────────────────────────────────────────────────

function rateToDelayMs(ratePerHour) {
  const rate = ratePerHour && ratePerHour > 0 ? ratePerHour : 100;
  return Math.floor(3_600_000 / rate);
}

function clearTimer(campaignId) {
  if (activeTimers.has(campaignId)) {
    clearTimeout(activeTimers.get(campaignId));
    activeTimers.delete(campaignId);
  }
}

function scheduleNext(campaignId, delayMs) {
  clearTimer(campaignId);
  const handle = setTimeout(() => processNextEmail(campaignId, delayMs), delayMs);
  activeTimers.set(campaignId, handle);
}

async function processNextEmail(campaignId, delayMs) {
  try {
    // Fetch fresh status before every send
    const campaign = await Campaign.findById(campaignId).lean();

    if (!campaign) {
      activeTimers.delete(campaignId);
      return;
    }

    if (["paused", "cancelled", "completed", "failed"].includes(campaign.status)) {
      activeTimers.delete(campaignId);
      console.log(`[Queue] Campaign ${campaignId} timer stopped — status: ${campaign.status}`);
      return;
    }

    // Pick next pending log for this campaign only (FIFO)
    const log = await EmailLog.findOne({ campaignId, status: "pending" })
      .sort({ createdAt: 1 })
      .lean();

    if (!log) {
      // All logs processed — mark complete
      await Campaign.findByIdAndUpdate(campaignId, {
        status: "completed",
        completedAt: new Date(),
      });
      activeTimers.delete(campaignId);
      console.log(`[Queue] Campaign ${campaignId} completed`);
      return;
    }

    await processOne(log, campaign);

    // Schedule the next email
    scheduleNext(campaignId, delayMs);
  } catch (err) {
    console.error(`[Queue] processNextEmail error for campaign ${campaignId}:`, err.message);
    // Transient error — still schedule next rather than stopping the campaign
    scheduleNext(campaignId, delayMs);
  }
}

async function processOne(log, campaign) {
  try {
    const influencer = await Influencer.findById(log.influencerId).lean();

    if (!influencer || !influencer.email) {
      await EmailLog.findByIdAndUpdate(log._id, {
        status: "failed",
        errorMessage: "Influencer missing or has no email",
      });
      await Campaign.findByIdAndUpdate(log.campaignId, { $inc: { failedCount: 1 } });
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
    console.log(`[Queue] Sent to ${influencer.email} (campaign ${log.campaignId})`);
  } catch (err) {
    await EmailLog.findByIdAndUpdate(log._id, {
      status: "failed",
      errorMessage: err.message,
    });
    await Campaign.findByIdAndUpdate(log.campaignId, { $inc: { failedCount: 1 } });
    console.error(`[Queue] Email failed for log ${log._id}:`, err.message);
  }
}

// ── Audience builder ──────────────────────────────────────────────────────────
// Mirrors previewCampaign query logic exactly so preview count = actual send count.

async function enqueueCampaign(campaign) {
  let influencers = await buildAudience(campaign.templateType, campaign.targetFilters);

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

async function buildAudience(templateType, filters = {}) {
  const query = {
    is_active: true,
    email: { $exists: true, $ne: null, $ne: "" },
  };

  if (templateType === "incomplete-profile") {
    query.is_profile_completed = false;
  } else if (templateType === "unverified-email") {
    query.is_email_verified = false;
  } else if (templateType === "inactivity") {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    query.is_profile_completed = false;
    query.created_date = { $lte: sevenDaysAgo };
  }
  // custom / custom_all / custom_segment: no type-specific filter — only targetFilters below

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
    query.is_email_verified = filters.emailVerified;
  }
  if (filters.profileCompleted !== null && filters.profileCompleted !== undefined) {
    query.is_profile_completed = filters.profileCompleted;
  }
  if (filters.inactiveDays && filters.inactiveDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - filters.inactiveDays);
    query.created_date = { $lte: cutoff };
  }
  if (filters.minFollowers > 0 || filters.maxFollowers > 0) {
    const followersFilter = {};
    if (filters.minFollowers > 0) followersFilter.$gte = filters.minFollowers;
    if (filters.maxFollowers > 0) followersFilter.$lte = filters.maxFollowers;
    query["social_handles.followers"] = followersFilter;
  }

  return Influencer.find(query).select("_id name username email city country").lean();
}

module.exports = { startCampaign, pauseCampaign, resumeCampaign, stopCampaign, restoreRunningCampaigns };
