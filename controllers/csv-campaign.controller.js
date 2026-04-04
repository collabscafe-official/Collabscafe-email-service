const multer = require("multer");
const XLSX = require("xlsx");
const CsvCampaign = require("../models/CsvCampaign");
const {
  startCsvCampaign,
  pauseCsvCampaign,
  resumeCsvCampaign,
  stopCsvCampaign,
} = require("../services/csv-queue.service");

// ── File upload middleware ─────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(req, file, cb) {
    if (file.originalname.match(/\.(csv|xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV and Excel files (.csv, .xlsx, .xls) are accepted"));
    }
  },
});

// ── File parser ───────────────────────────────────────────────────────────────

// Keys treated as name / email — everything else goes into customFields
const NAME_KEYS  = new Set(["name", "full name", "fullname", "first name", "firstname"]);
const EMAIL_KEYS = new Set(["email", "email address", "e-mail", "emailaddress"]);

function parseFileBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const recipients = [];
  const errors = [];
  const extraColumns = new Set(); // all non-name/email column keys found

  rows.forEach((row, idx) => {
    // Normalize keys: lowercase, strip whitespace
    const norm = {};
    for (const key of Object.keys(row)) {
      norm[key.toLowerCase().trim().replace(/\s+/g, " ")] = String(row[key]).trim();
    }

    const email =
      norm["email"] ||
      norm["email address"] ||
      norm["e-mail"] ||
      norm["emailaddress"] ||
      "";

    const name =
      norm["name"] ||
      norm["full name"] ||
      norm["fullname"] ||
      norm["first name"] ||
      norm["firstname"] ||
      "";

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (email) errors.push(`Row ${idx + 2}: invalid email "${email}"`);
      return;
    }

    // Collect all extra columns as customFields
    const customFields = {};
    for (const [key, value] of Object.entries(norm)) {
      if (!NAME_KEYS.has(key) && !EMAIL_KEYS.has(key) && value) {
        // Use original casing from header row as the template variable key
        customFields[key] = value;
        extraColumns.add(key);
      }
    }

    recipients.push({ name, email, customFields });
  });

  return { recipients, errors, columns: Array.from(extraColumns) };
}

// ── Controllers ───────────────────────────────────────────────────────────────

// POST /csv-campaigns/parse  (multipart)
async function parseFile(req, res) {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { recipients, errors, columns } = parseFileBuffer(req.file.buffer);
  res.json({ recipients, count: recipients.length, errors, columns });
}

// GET /csv-campaigns
async function listCsvCampaigns(req, res) {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [campaigns, total] = await Promise.all([
    CsvCampaign.find(filter)
      .select("-recipients")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    CsvCampaign.countDocuments(filter),
  ]);

  res.json({ campaigns, total, page: parseInt(page), limit: parseInt(limit) });
}

// GET /csv-campaigns/:id
async function getCsvCampaign(req, res) {
  const campaign = await CsvCampaign.findById(req.params.id).select("-recipients").lean();
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json(campaign);
}

// GET /csv-campaigns/:id/recipients
async function getCsvCampaignRecipients(req, res) {
  const { status, page = 1, limit = 50 } = req.query;
  const parsedPage = Math.max(1, parseInt(page));
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (parsedPage - 1) * parsedLimit;

  const campaign = await CsvCampaign.findById(req.params.id).lean();
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  let recipients = campaign.recipients;
  if (status) recipients = recipients.filter((r) => r.status === status);

  const total = recipients.length;
  const paginated = recipients.slice(skip, skip + parsedLimit);

  res.json({
    recipients: paginated,
    total,
    page: parsedPage,
    totalPages: Math.ceil(total / parsedLimit),
  });
}

// POST /csv-campaigns
async function createCsvCampaign(req, res) {
  const { name, subject, htmlContent, ratePerHour, recipients } = req.body;

  if (!name || !subject) {
    return res.status(400).json({ error: "name and subject are required" });
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "recipients array is required and must not be empty" });
  }

  const valid = recipients.filter(
    (r) => r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)
  );
  if (valid.length === 0) {
    return res.status(400).json({ error: "No valid recipient emails found" });
  }

  const campaign = await CsvCampaign.create({
    name,
    subject,
    htmlContent: htmlContent || "",
    ratePerHour: ratePerHour && ratePerHour > 0 ? Math.floor(ratePerHour) : 100,
    totalTargeted: valid.length,
    recipients: valid.map((r) => ({
      name: r.name || "",
      email: r.email,
      customFields: r.customFields || {},
      status: "pending",
    })),
  });

  res.status(201).json(campaign);
}

// PATCH /csv-campaigns/:id
async function updateCsvCampaign(req, res) {
  const campaign = await CsvCampaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (["running", "paused"].includes(campaign.status)) {
    return res.status(409).json({ error: "Cannot edit a running or paused campaign" });
  }

  const allowed = ["name", "subject", "htmlContent", "ratePerHour"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) campaign[key] = req.body[key];
  }
  await campaign.save();
  res.json(campaign);
}

// DELETE /csv-campaigns/:id
async function deleteCsvCampaign(req, res) {
  const campaign = await CsvCampaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (campaign.status === "running") {
    return res.status(409).json({ error: "Cannot delete a running campaign" });
  }

  await campaign.deleteOne();
  res.json({ message: "Campaign deleted" });
}

// POST /csv-campaigns/:id/send
async function sendCsvCampaign(req, res) {
  const campaign = await CsvCampaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (campaign.status === "running") {
    return res.status(409).json({ error: "Campaign is already running" });
  }
  if (campaign.status === "completed") {
    return res.status(409).json({ error: "Campaign already completed" });
  }

  // Reset all recipients to pending for re-runs
  campaign.sentCount = 0;
  campaign.failedCount = 0;
  campaign.startedAt = null;
  campaign.completedAt = null;
  for (const r of campaign.recipients) {
    r.status = "pending";
    r.sentAt = null;
    r.errorMessage = "";
    r.messageId = "";
  }
  await campaign.save();

  const count = await startCsvCampaign(campaign);
  res.json({ message: "Campaign started", totalTargeted: count });
}

// POST /csv-campaigns/:id/pause
async function pauseCsvCampaignController(req, res) {
  const campaign = await CsvCampaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (campaign.status !== "running") {
    return res.status(409).json({ error: "Campaign is not running" });
  }
  await pauseCsvCampaign(campaign._id);
  res.json({ message: "Campaign paused" });
}

// POST /csv-campaigns/:id/resume
async function resumeCsvCampaignController(req, res) {
  const campaign = await CsvCampaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (campaign.status !== "paused") {
    return res.status(409).json({ error: "Campaign is not paused" });
  }
  await resumeCsvCampaign(campaign._id);
  res.json({ message: "Campaign resumed" });
}

// POST /csv-campaigns/:id/stop
async function stopCsvCampaignController(req, res) {
  const campaign = await CsvCampaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (!["running", "paused"].includes(campaign.status)) {
    return res.status(409).json({ error: "Campaign is not running or paused" });
  }
  await stopCsvCampaign(campaign._id);
  res.json({ message: "Campaign stopped" });
}

module.exports = {
  upload,
  parseFile,
  listCsvCampaigns,
  getCsvCampaign,
  getCsvCampaignRecipients,
  createCsvCampaign,
  updateCsvCampaign,
  deleteCsvCampaign,
  sendCsvCampaign,
  pauseCsvCampaignController,
  resumeCsvCampaignController,
  stopCsvCampaignController,
};
