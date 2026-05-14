const mongoose = require("mongoose");

const STATUSES = ["pending", "sent", "failed", "bounced", "cancelled"];
const AUDIENCES = ["creator", "brand"];

const emailLogSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },
    // Which audience type this log is for. Distinguishes which recipient ID
    // field below is populated. Defaults to 'creator' so existing logs (which
    // have influencerId set) keep working without backfill.
    audience: {
      type: String,
      enum: AUDIENCES,
      default: "creator",
    },
    // For creator campaigns. Optional now (it was required before — relaxed
    // because brand campaigns use brandId instead). Existing creator logs
    // already have this populated.
    influencerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Influencer",
    },
    // For brand campaigns. Mutually exclusive with influencerId.
    brandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
    },
    email: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: STATUSES,
      default: "pending",
      index: true,
    },
    messageId: {
      type: String,
      default: null, // SES message ID returned on successful send
    },
    errorMessage: {
      type: String,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Prevent duplicate sends per campaign + recipient.
// Two PARTIAL unique indexes — one per audience type — so that null values in
// the "other" field never trigger a unique-constraint collision.
// Creator campaign rows have influencerId set + brandId missing → use index #1.
// Brand campaign rows have brandId set + influencerId missing → use index #2.
emailLogSchema.index(
  { campaignId: 1, influencerId: 1 },
  { unique: true, partialFilterExpression: { influencerId: { $exists: true } } }
);
emailLogSchema.index(
  { campaignId: 1, brandId: 1 },
  { unique: true, partialFilterExpression: { brandId: { $exists: true } } }
);

module.exports = mongoose.model("EmailLog", emailLogSchema);
