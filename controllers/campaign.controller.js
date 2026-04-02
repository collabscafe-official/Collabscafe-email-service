const Campaign = require("../models/Campaign");
const EmailLog = require("../models/EmailLog");
const Influencer = require("../models/Influencer");
const { startCampaign, pauseCampaign, resumeCampaign, stopCampaign } = require("../services/queue.service");

// GET /campaigns
async function listCampaigns(req, res) {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [campaigns, total] = await Promise.all([
    Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    Campaign.countDocuments(filter),
  ]);

  res.json({ campaigns, total, page: parseInt(page), limit: parseInt(limit) });
}

// GET /campaigns/:id
async function getCampaign(req, res) {
  const campaign = await Campaign.findById(req.params.id).lean();
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json(campaign);
}

// POST /campaigns
async function createCampaign(req, res) {
  const { name, description, templateType, subject, customBody, targetFilters, excluded_ids, rate_per_hour } = req.body;

  if (!name || !templateType || !subject) {
    return res.status(400).json({ error: "name, templateType, and subject are required" });
  }
  if (templateType === "custom" && !customBody) {
    return res.status(400).json({ error: "customBody is required for custom template type" });
  }

  const campaign = await Campaign.create({
    name,
    description,
    templateType,
    subject,
    customBody,
    targetFilters: targetFilters || {},
    excludedIds: Array.isArray(excluded_ids) ? excluded_ids : [],
    ratePerHour: rate_per_hour && rate_per_hour > 0 ? Math.floor(rate_per_hour) : 100,
  });

  res.status(201).json(campaign);
}

// PATCH /campaigns/:id
async function updateCampaign(req, res) {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (["running", "paused"].includes(campaign.status)) {
    return res.status(409).json({ error: "Cannot edit a running or paused campaign" });
  }

  const allowed = ["name", "description", "templateType", "subject", "customBody", "targetFilters"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) campaign[key] = req.body[key];
  }

  await campaign.save();
  res.json(campaign);
}

// DELETE /campaigns/:id
async function deleteCampaign(req, res) {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (campaign.status === "running") {
    return res.status(409).json({ error: "Cannot delete a running campaign" });
  }

  await EmailLog.deleteMany({ campaignId: campaign._id });
  await campaign.deleteOne();
  res.json({ message: "Campaign deleted" });
}

// POST /campaigns/:id/send
async function sendCampaign(req, res) {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (campaign.status === "running") {
    return res.status(409).json({ error: "Campaign is already running" });
  }
  if (campaign.status === "completed") {
    return res.status(409).json({ error: "Campaign already completed. Duplicate it to resend." });
  }

  // Reset counters for re-runs from draft/failed
  campaign.sentCount = 0;
  campaign.failedCount = 0;
  campaign.totalTargeted = 0;
  campaign.startedAt = null;
  campaign.completedAt = null;
  await campaign.save();

  // Clear any existing logs for this campaign
  await EmailLog.deleteMany({ campaignId: campaign._id });

  const count = await startCampaign(campaign);
  res.json({ message: "Campaign started", totalTargeted: count });
}

// GET /campaigns/:id/logs
async function getCampaignLogs(req, res) {
  const { status, page = 1, limit = 50 } = req.query;
  const filter = { campaignId: req.params.id };
  if (status) filter.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [logs, total] = await Promise.all([
    EmailLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    EmailLog.countDocuments(filter),
  ]);

  res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
}

// POST /campaigns/preview
async function previewCampaign(req, res) {
  const { type, filters } = req.body;

  if (!type) {
    return res.status(400).json({
      success: false,
      message: 'Campaign type is required'
    });
  }

  // Build query based on type
  let query = { is_active: true };

  if (type === 'incomplete_profile') {
    query.is_profile_completed = false;
  } else if (type === 'unverified_email') {
    query.is_email_verified = false;
  } else if (type === 'inactivity') {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    query.is_profile_completed = false;
    query.created_date = { $lte: sevenDaysAgo };
  } else if (type === 'custom_segment' && filters) {
    if (filters.is_profile_completed !== null &&
        filters.is_profile_completed !== undefined) {
      query.is_profile_completed = filters.is_profile_completed;
    }
    if (filters.is_email_verified !== null &&
        filters.is_email_verified !== undefined) {
      query.is_email_verified = filters.is_email_verified;
    }
    if (filters.is_approved_by_admin !== null &&
        filters.is_approved_by_admin !== undefined) {
      query.is_approved_by_admin = filters.is_approved_by_admin;
    }
    if (filters.country) query.country = filters.country;
    if (filters.gender) query.gender = filters.gender;
  }
  // custom_all: no additional filters, sends to all active

  // Only fetch creators with a valid email
  query.email = { $exists: true, $ne: null, $ne: '' };

  const total = await Influencer.countDocuments(query);
  const sample = await Influencer.find(query)
    .select('name email')
    .limit(5)
    .lean();

  return res.json({
    success: true,
    count: total,
    sample: sample.map(c => ({
      name: c.name || 'Creator',
      email: c.email
    }))
  });
}

// GET /campaigns/preview/all?type=&page=&limit=&[filters]
async function previewAll(req, res) {
  const { type, page = 1, limit = 50 } = req.query;

  if (!type) {
    return res.status(400).json({ success: false, message: 'type is required' });
  }

  // Build same query as previewCampaign
  let query = { is_active: true };

  if (type === 'incomplete_profile') {
    query.is_profile_completed = false;
  } else if (type === 'unverified_email') {
    query.is_email_verified = false;
  } else if (type === 'inactivity') {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    query.is_profile_completed = false;
    query.created_date = { $lte: sevenDaysAgo };
  } else if (type === 'custom_segment') {
    if (req.query.is_profile_completed !== undefined)
      query.is_profile_completed = req.query.is_profile_completed === 'true';
    if (req.query.is_email_verified !== undefined)
      query.is_email_verified = req.query.is_email_verified === 'true';
    if (req.query.is_approved_by_admin !== undefined)
      query.is_approved_by_admin = req.query.is_approved_by_admin === 'true';
    if (req.query.country) query.country = req.query.country;
    if (req.query.gender)  query.gender  = req.query.gender;
  }
  // custom_all: no additional filters

  query.email = { $exists: true, $ne: null, $ne: '' };

  const parsedPage  = Math.max(1, parseInt(page));
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (parsedPage - 1) * parsedLimit;

  const [creators, total] = await Promise.all([
    Influencer.find(query)
      .select('_id name email')
      .skip(skip)
      .limit(parsedLimit)
      .lean(),
    Influencer.countDocuments(query),
  ]);

  return res.json({
    success: true,
    creators: creators.map(c => ({
      _id: String(c._id),
      name: c.name || 'Creator',
      email: c.email,
    })),
    total,
    page: parsedPage,
    totalPages: Math.ceil(total / parsedLimit),
  });
}

// POST /campaigns/:id/pause
async function pauseCampaignController(req, res) {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (campaign.status !== "running") {
    return res.status(409).json({ error: "Campaign is not running" });
  }
  await pauseCampaign(campaign._id);
  res.json({ message: "Campaign paused" });
}

// POST /campaigns/:id/resume
async function resumeCampaignController(req, res) {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (campaign.status !== "paused") {
    return res.status(409).json({ error: "Campaign is not paused" });
  }
  await resumeCampaign(campaign._id);
  res.json({ message: "Campaign resumed" });
}

// POST /campaigns/:id/stop
async function stopCampaignController(req, res) {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (!["running", "paused"].includes(campaign.status)) {
    return res.status(409).json({ error: "Campaign is not running or paused" });
  }
  await stopCampaign(campaign._id);
  res.json({ message: "Campaign stopped" });
}

// GET /campaigns/templates/:type
const TEMPLATES = {
  incomplete_profile: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Complete Your Profile</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #079f82 0%, #7c6edd 100%); padding: 40px 32px; text-align: center; }
    .header img { width: 140px; margin-bottom: 16px; }
    .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; }
    .body { padding: 36px 32px; }
    .body p { margin: 0 0 16px; color: #374151; font-size: 15px; line-height: 1.6; }
    .cta { display: block; width: fit-content; margin: 28px auto 0; background: linear-gradient(135deg, #079f82, #7c6edd); color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-size: 15px; font-weight: 600; text-align: center; }
    .footer { padding: 24px 32px; text-align: center; background: #f9fafb; border-top: 1px solid #f0f0f0; }
    .footer p { margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6; }
    .footer a { color: #079f82; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Complete Your Profile</h1>
    </div>
    <div class="body">
      <p>Hi {{first_name}},</p>
      <p>
        Your Collabscafe profile is almost there! Brands browsing our platform are
        more likely to reach out to creators with complete profiles — so don't miss out.
      </p>
      <p>
        Adding your bio, social handles, portfolio, and pricing only takes a few minutes
        and dramatically increases your chances of getting discovered.
      </p>
      <a href="{{profile_url}}" class="cta">Complete My Profile</a>
    </div>
    <div class="footer">
      <p>
        You're receiving this because you have an account on
        <a href="https://collabscafe.com">Collabscafe</a>.<br />
        <a href="https://collabscafe.com/unsubscribe?email={{email}}">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`,

  unverified_email: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify Your Email</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #079f82 0%, #7c6edd 100%); padding: 40px 32px; text-align: center; }
    .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; }
    .body { padding: 36px 32px; }
    .body p { margin: 0 0 16px; color: #374151; font-size: 15px; line-height: 1.6; }
    .notice { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 14px 18px; border-radius: 6px; margin: 0 0 20px; }
    .notice p { margin: 0; color: #92400e; font-size: 14px; }
    .cta { display: block; width: fit-content; margin: 28px auto 0; background: linear-gradient(135deg, #079f82, #7c6edd); color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-size: 15px; font-weight: 600; text-align: center; }
    .footer { padding: 24px 32px; text-align: center; background: #f9fafb; border-top: 1px solid #f0f0f0; }
    .footer p { margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6; }
    .footer a { color: #079f82; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Please Verify Your Email</h1>
    </div>
    <div class="body">
      <p>Hi {{first_name}},</p>
      <div class="notice">
        <p>Your email address hasn't been verified yet. Some features are limited until you verify.</p>
      </div>
      <p>
        Verifying your email helps brands trust your profile and ensures you receive
        important notifications about collaboration requests.
      </p>
      <p>Click the button below to verify your email address and unlock your full profile.</p>
      <a href="{{profile_url}}" class="cta">Verify My Email</a>
    </div>
    <div class="footer">
      <p>
        You're receiving this because you have an account on
        <a href="https://collabscafe.com">Collabscafe</a>.<br />
        <a href="https://collabscafe.com/unsubscribe?email={{email}}">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`,

  inactivity: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>We Miss You</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #079f82 0%, #7c6edd 100%); padding: 40px 32px; text-align: center; }
    .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; }
    .header p { margin: 8px 0 0; color: rgba(255,255,255,0.85); font-size: 14px; }
    .body { padding: 36px 32px; }
    .body p { margin: 0 0 16px; color: #374151; font-size: 15px; line-height: 1.6; }
    .highlight { background: #f0fdf9; border-radius: 8px; padding: 16px 20px; margin: 0 0 20px; }
    .highlight p { margin: 0; color: #065f46; font-size: 14px; }
    .cta { display: block; width: fit-content; margin: 28px auto 0; background: linear-gradient(135deg, #079f82, #7c6edd); color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-size: 15px; font-weight: 600; text-align: center; }
    .footer { padding: 24px 32px; text-align: center; background: #f9fafb; border-top: 1px solid #f0f0f0; }
    .footer p { margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6; }
    .footer a { color: #079f82; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>We Miss You, {{first_name}}!</h1>
      <p>Brands are looking for creators like you</p>
    </div>
    <div class="body">
      <p>Hi {{first_name}},</p>
      <p>
        It's been a while since we've seen you on Collabscafe. A lot has happened
        since your last visit — new brands, new campaigns, and new collaboration
        opportunities are waiting for you.
      </p>
      <div class="highlight">
        <p>
          Your profile is still live and brands can discover you.
          Log back in to check your messages and update your availability.
        </p>
      </div>
      <p>
        Don't let your hard work go unnoticed. Come back and see what's new.
      </p>
      <a href="{{profile_url}}" class="cta">Go to My Profile</a>
    </div>
    <div class="footer">
      <p>
        You're receiving this because you have an account on
        <a href="https://collabscafe.com">Collabscafe</a>.<br />
        <a href="https://collabscafe.com/unsubscribe?email={{email}}">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`,

  custom_all: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Message from Collabscafe</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #079f82 0%, #7c6edd 100%); padding: 40px 32px; text-align: center; }
    .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; }
    .body { padding: 36px 32px; color: #374151; font-size: 15px; line-height: 1.6; }
    .footer { padding: 24px 32px; text-align: center; background: #f9fafb; border-top: 1px solid #f0f0f0; }
    .footer p { margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6; }
    .footer a { color: #079f82; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>Message from Collabscafe</h1>
    </div>
    <div class="body">
      {{custom_body}}
    </div>
    <div class="footer">
      <p>
        You're receiving this because you have an account on
        <a href="https://collabscafe.com">Collabscafe</a>.<br />
        <a href="https://collabscafe.com/unsubscribe?email={{email}}">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`,
};
TEMPLATES.custom_segment = TEMPLATES.custom_all;

async function getTemplate(req, res) {
  const { type } = req.params;
  const html = TEMPLATES[type];
  if (!html) {
    return res.status(404).json({ success: false, message: "Template not found" });
  }
  return res.json({ success: true, type, html });
}

module.exports = {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  sendCampaign,
  pauseCampaignController,
  resumeCampaignController,
  stopCampaignController,
  getCampaignLogs,
  previewCampaign,
  previewAll,
  getTemplate,
};
