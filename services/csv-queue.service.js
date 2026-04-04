const CsvCampaign = require("../models/CsvCampaign");
const { sendEmail } = require("./ses.service");

// campaignId (string) → setTimeout handle
const activeTimers = new Map();

// ── Public API ────────────────────────────────────────────────────────────────

async function startCsvCampaign(campaign) {
  const pending = campaign.recipients.filter((r) => r.status === "pending");
  if (pending.length === 0) return 0;

  await CsvCampaign.findByIdAndUpdate(campaign._id, {
    status: "running",
    startedAt: new Date(),
    completedAt: null,
  });

  const delayMs = rateToDelayMs(campaign.ratePerHour);
  scheduleNext(String(campaign._id), delayMs);
  return pending.length;
}

async function pauseCsvCampaign(campaignId) {
  const id = String(campaignId);
  clearTimer(id);
  await CsvCampaign.findByIdAndUpdate(campaignId, {
    status: "paused",
    pausedAt: new Date(),
  });
  console.log(`[CsvQueue] Campaign ${id} paused`);
}

async function resumeCsvCampaign(campaignId) {
  const campaign = await CsvCampaign.findByIdAndUpdate(
    campaignId,
    { status: "running", pausedAt: null },
    { new: true }
  ).lean();
  if (!campaign) return;
  const delayMs = rateToDelayMs(campaign.ratePerHour);
  scheduleNext(String(campaignId), delayMs);
  console.log(`[CsvQueue] Campaign ${campaignId} resumed`);
}

async function stopCsvCampaign(campaignId) {
  const id = String(campaignId);
  clearTimer(id);
  await CsvCampaign.updateOne(
    { _id: campaignId },
    {
      $set: {
        status: "cancelled",
        stoppedAt: new Date(),
        "recipients.$[elem].status": "cancelled",
      },
    },
    { arrayFilters: [{ "elem.status": "pending" }] }
  );
  console.log(`[CsvQueue] Campaign ${id} stopped`);
}

async function restoreRunningCsvCampaigns() {
  const running = await CsvCampaign.find({ status: "running" }).lean();
  if (running.length === 0) return;
  console.log(`[CsvQueue] Restoring ${running.length} CSV campaign(s)...`);
  for (const campaign of running) {
    const delayMs = rateToDelayMs(campaign.ratePerHour);
    scheduleNext(String(campaign._id), delayMs);
    console.log(`[CsvQueue] Restored CSV campaign ${campaign._id}`);
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
    const campaign = await CsvCampaign.findById(campaignId).lean();
    if (!campaign) { activeTimers.delete(campaignId); return; }

    if (["paused", "cancelled", "completed", "failed"].includes(campaign.status)) {
      activeTimers.delete(campaignId);
      console.log(`[CsvQueue] Campaign ${campaignId} timer stopped — status: ${campaign.status}`);
      return;
    }

    const recipient = campaign.recipients.find((r) => r.status === "pending");
    if (!recipient) {
      await CsvCampaign.findByIdAndUpdate(campaignId, {
        status: "completed",
        completedAt: new Date(),
      });
      activeTimers.delete(campaignId);
      console.log(`[CsvQueue] Campaign ${campaignId} completed`);
      return;
    }

    await processOne(campaign, recipient);
    scheduleNext(campaignId, delayMs);
  } catch (err) {
    console.error(`[CsvQueue] processNextEmail error for campaign ${campaignId}:`, err.message);
    scheduleNext(campaignId, delayMs);
  }
}

async function processOne(campaign, recipient) {
  try {
    if (!recipient.email) {
      await markRecipient(campaign._id, recipient._id, "failed", null, "No email address");
      await CsvCampaign.findByIdAndUpdate(campaign._id, { $inc: { failedCount: 1 } });
      return;
    }

    const firstName = (recipient.name || "Creator").split(" ")[0];
    const fields = recipient.customFields instanceof Map
      ? Object.fromEntries(recipient.customFields)
      : (recipient.customFields || {});

    const applyVars = (str) => {
      let out = str;
      out = out.replace(/{{\s*first_name\s*}}/gi, firstName);
      out = out.replace(/{{\s*name\s*}}/gi, recipient.name || "Creator");
      out = out.replace(/{{\s*email\s*}}/gi, recipient.email);
      for (const [key, value] of Object.entries(fields)) {
        out = out.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), value || "");
      }
      out = out.replace(/{{\s*\w+\s*}}/g, "");
      return out;
    };

    const subject = applyVars(campaign.subject);
    const html    = applyVars(campaign.htmlContent || "");

    const messageId = await sendEmail({
      to: recipient.email,
      subject,
      htmlBody: html,
    });

    await markRecipient(campaign._id, recipient._id, "sent", messageId, null);
    await CsvCampaign.findByIdAndUpdate(campaign._id, { $inc: { sentCount: 1 } });
    console.log(`[CsvQueue] Sent to ${recipient.email} (campaign ${campaign._id})`);
  } catch (err) {
    await markRecipient(campaign._id, recipient._id, "failed", null, err.message);
    await CsvCampaign.findByIdAndUpdate(campaign._id, { $inc: { failedCount: 1 } });
    console.error(`[CsvQueue] Email failed for ${recipient.email}:`, err.message);
  }
}

async function markRecipient(campaignId, recipientId, status, messageId, errorMessage) {
  const update = {
    "recipients.$.status": status,
    "recipients.$.sentAt": status === "sent" ? new Date() : null,
  };
  if (messageId) update["recipients.$.messageId"] = messageId;
  if (errorMessage) update["recipients.$.errorMessage"] = errorMessage;
  await CsvCampaign.updateOne(
    { _id: campaignId, "recipients._id": recipientId },
    { $set: update }
  );
}

module.exports = {
  startCsvCampaign,
  pauseCsvCampaign,
  resumeCsvCampaign,
  stopCsvCampaign,
  restoreRunningCsvCampaigns,
};
