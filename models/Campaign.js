const mongoose = require("mongoose");

const TEMPLATE_TYPES = ["incomplete-profile", "unverified-email", "inactivity", "custom"];
const STATUSES = ["draft", "running", "paused", "completed", "failed", "cancelled"];

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

    // Explicitly excluded influencer IDs (set at send time)
    excludedIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Influencer" }],

    // Audience targeting filters
    targetFilters: {
      platform: { type: String, default: "" },       // e.g. "instagram"
      country: { type: String, default: "" },
      city: { type: String, default: "" },
      minFollowers: { type: Number, default: 0 },
      maxFollowers: { type: Number, default: 0 },    // 0 = no upper limit
      emailVerified: { type: Boolean, default: null }, // null = no filter
      profileCompleted: { type: Boolean, default: null },
      inactiveDays: { type: Number, default: 0 },    // inactive for N+ days (0 = ignore)
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
