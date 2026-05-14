const mongoose = require("mongoose");

const TEMPLATE_TYPES = ["incomplete-profile", "unverified-email", "inactivity", "custom"];
const STATUSES = ["draft", "running", "paused", "completed", "failed", "cancelled"];
const AUDIENCES = ["creator", "brand"];

const campaignSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    // Who this campaign targets. 'creator' (default, back-compat with existing
    // rows) queries the Influencer collection; 'brand' queries Brand. Filter
    // shapes differ — see targetFilters.brand below.
    audience: {
      type: String,
      enum: AUDIENCES,
      default: "creator",
      index: true,
    },
    templateType: {
      type: String,
      enum: TEMPLATE_TYPES,
      required: true,
    },

    // Email content
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    // Only used when templateType === "custom"
    customBody: {
      type: String,
      default: "",
    },

    // Explicitly excluded recipient IDs (set at send time).
    // For creator campaigns these are Influencer _ids; for brand they're Brand _ids.
    // Same field works for both since the value is just an ObjectId.
    excludedIds: [{ type: mongoose.Schema.Types.ObjectId }],

    // Audience targeting filters.
    // Creator-specific fields live at the top of the object (legacy shape).
    // Brand-specific fields live under `brand` so the two filter sets don't
    // collide and existing creator campaigns continue to work unchanged.
    targetFilters: {
      // ── Creator filters (audience === 'creator') ──
      platform: { type: String, default: "" },
      country: { type: String, default: "" },
      city: { type: String, default: "" },
      minFollowers: { type: Number, default: 0 },
      maxFollowers: { type: Number, default: 0 },
      emailVerified: { type: Boolean, default: null },
      profileCompleted: { type: Boolean, default: null },
      inactiveDays: { type: Number, default: 0 },

      // ── Brand filters (audience === 'brand') ──
      brand: {
        categories: [{ type: String }],          // industries multi-select
        campaignGoals: [{ type: String }],       // Awareness / Sales / UGC etc.
        country: { type: String, default: "" },
        city: { type: String, default: "" },
        emailVerified: { type: Boolean, default: null },
        profileCompleted: { type: Boolean, default: null },
      },
    },

    status: {
      type: String,
      enum: STATUSES,
      default: "draft",
    },
    // Rate control
    ratePerHour: { type: Number, default: 100 },   // max emails per hour

    totalTargeted: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.model("Campaign", campaignSchema);
