const Campaign = require("../models/Campaign");
const EmailLog = require("../models/EmailLog");
const Influencer = require("../models/Influencer");
const Brand = require("../models/Brand");
const BrandTeamMember = require("../models/BrandTeamMember");
const { sendEmail } = require("./ses.service");
const { renderForCampaign, renderSubjectForCampaign } = require("./template.service");

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
    // Pick the right recipient collection based on campaign audience.
    // log.audience is the source of truth (defaults to 'creator' on legacy logs);
    // fall back to campaign.audience for safety.
    const audience = log.audience || campaign.audience || "creator";
    let recipient = null;
    if (audience === "brand") {
      if (!log.brandId) {
        await failLog(log, "Brand campaign log missing brandId");
        return;
      }
      recipient = await Brand.findById(log.brandId).lean();
    } else {
      if (!log.influencerId) {
        await failLog(log, "Creator campaign log missing influencerId");
        return;
      }
      recipient = await Influencer.findById(log.influencerId).lean();
    }

    if (!recipient || !recipient.email) {
      await failLog(log, "Recipient missing or has no email");
      return;
    }

    // Skip soft-deleted brands too (creators don't have an is_deleted flag in
    // the read model). Defensive — also filtered at enqueue time.
    if (audience === "brand" && recipient.is_deleted) {
      await failLog(log, "Brand is_deleted=true at send time");
      return;
    }

    // For brand audience, resolve the contact person from brand_team_members.
    // Prefer the admin team member; fall back to most-recent active member;
    // fall back to null (template.service handles the brand_name fallback).
    let brandContact = null;
    if (audience === "brand") {
      brandContact = await BrandTeamMember.findOne({
        brand: log.brandId,
        is_admin: true,
        is_active: true,
        is_deleted: { $ne: true },
      }).lean();
      if (!brandContact) {
        brandContact = await BrandTeamMember.findOne({
          brand: log.brandId,
          is_active: true,
          is_deleted: { $ne: true },
        }).sort({ created_at: -1, createdAt: -1, _id: -1 }).lean();
      }
    }

    const htmlBody = renderForCampaign(campaign, recipient, audience, brandContact);
    const subject  = renderSubjectForCampaign(campaign, recipient, audience, brandContact);
    const messageId = await sendEmail({
      to: recipient.email,
      subject,
      htmlBody,
    });

    await EmailLog.findByIdAndUpdate(log._id, {
      status: "sent",
      messageId,
      sentAt: new Date(),
    });

    await Campaign.findByIdAndUpdate(log.campaignId, { $inc: { sentCount: 1 } });
    console.log(`[Queue] Sent to ${recipient.email} (campaign ${log.campaignId}, audience=${audience})`);
  } catch (err) {
    await failLog(log, err.message);
    console.error(`[Queue] Email failed for log ${log._id}:`, err.message);
  }
}

async function failLog(log, errorMessage) {
  await EmailLog.findByIdAndUpdate(log._id, {
    status: "failed",
    errorMessage,
  });
  await Campaign.findByIdAndUpdate(log.campaignId, { $inc: { failedCount: 1 } });
}

// ── Audience builder ──────────────────────────────────────────────────────────
// Mirrors previewCampaign query logic exactly so preview count = actual send count.

async function enqueueCampaign(campaign) {
  const audience = campaign.audience || "creator";
  let recipients;
  if (audience === "brand") {
    recipients = await buildBrandAudience(campaign.targetFilters?.brand || {});
  } else {
    recipients = await buildCreatorAudience(campaign.templateType, campaign.targetFilters || {});
  }

  if (campaign.excludedIds && campaign.excludedIds.length > 0) {
    const excludedSet = new Set(campaign.excludedIds.map((id) => String(id)));
    recipients = recipients.filter((r) => !excludedSet.has(String(r._id)));
  }

  if (recipients.length === 0) {
    await Campaign.findByIdAndUpdate(campaign._id, {
      status: "completed",
      totalTargeted: 0,
      completedAt: new Date(),
    });
    return 0;
  }

  // Bulk-insert pending logs (skip duplicates via upsert).
  // Brand vs creator: populate the right ID field; partial unique indexes on
  // EmailLog ({campaignId, influencerId} for creators, {campaignId, brandId}
  // for brands) prevent duplicates per audience.
  const ops = recipients.map((r) => {
    const setOnInsert = {
      campaignId: campaign._id,
      email: r.email,
      status: "pending",
      audience,
    };
    if (audience === "brand") {
      setOnInsert.brandId = r._id;
      return {
        updateOne: {
          filter: { campaignId: campaign._id, brandId: r._id },
          update: { $setOnInsert: setOnInsert },
          upsert: true,
        },
      };
    }
    setOnInsert.influencerId = r._id;
    return {
      updateOne: {
        filter: { campaignId: campaign._id, influencerId: r._id },
        update: { $setOnInsert: setOnInsert },
        upsert: true,
      },
    };
  });

  await EmailLog.bulkWrite(ops, { ordered: false });

  await Campaign.findByIdAndUpdate(campaign._id, {
    status: "running",
    totalTargeted: recipients.length,
    startedAt: new Date(),
  });

  console.log(`[Queue] Campaign ${campaign._id} enqueued ${recipients.length} ${audience}(s)`);
  return recipients.length;
}

async function buildCreatorAudience(templateType, filters = {}) {
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

async function buildBrandAudience(filters = {}) {
  const query = {
    is_active: true,
    is_deleted: { $ne: true },
    email: { $exists: true, $ne: null, $ne: "" },
  };
  if (Array.isArray(filters.categories) && filters.categories.length > 0) {
    query.category = { $in: filters.categories };
  }
  if (Array.isArray(filters.campaignGoals) && filters.campaignGoals.length > 0) {
    query.campaign_goal = { $in: filters.campaignGoals };
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
  return Brand.find(query).select("_id brand_name email category campaign_goal country city").lean();
}

module.exports = { startCampaign, pauseCampaign, resumeCampaign, stopCampaign, restoreRunningCampaigns };
