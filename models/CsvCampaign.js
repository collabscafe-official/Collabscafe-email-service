const mongoose = require("mongoose");

const STATUSES = ["draft", "running", "paused", "completed", "failed", "cancelled"];

const recipientSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true },
    customFields: { type: Map, of: String, default: {} },
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "cancelled"],
      default: "pending",
    },
    sentAt: { type: Date, default: null },
    errorMessage: { type: String, default: "" },
    messageId: { type: String, default: "" },
  },
  { _id: true }
);

const csvCampaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    htmlContent: { type: String, default: "" },
    status: { type: String, enum: STATUSES, default: "draft" },
    ratePerHour: { type: Number, default: 100 },
    totalTargeted: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    recipients: [recipientSchema],
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("CsvCampaign", csvCampaignSchema);
