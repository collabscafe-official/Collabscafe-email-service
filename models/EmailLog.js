const mongoose = require("mongoose");

const STATUSES = ["pending", "sent", "failed", "bounced"];

const emailLogSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },
    influencerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Influencer",
      required: true,
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

// Prevent duplicate sends per campaign + influencer
emailLogSchema.index({ campaignId: 1, influencerId: 1 }, { unique: true });

module.exports = mongoose.model("EmailLog", emailLogSchema);
