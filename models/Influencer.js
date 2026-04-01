const mongoose = require("mongoose");

// Read-only mirror of the influencer collection in the main DB.
// Only fields needed for email targeting and template variables are declared.
const influencerSchema = new mongoose.Schema(
  {
    name: String,
    username: String,
    email: String,
    email_verified: { type: Boolean, default: false },
    profile_completed: { type: Boolean, default: false },
    profile_title: String,
    city: String,
    country: String,
    last_active: Date,
    social_handles: [
      {
        platform: String,
        handle: String,
        followers: Number,
        _id: false,
      },
    ],
    createdAt: Date,
    updatedAt: Date,
  },
  {
    collection: "influencers", // must match the exact collection name in main DB
    strict: false,             // allow extra fields without crashing
    timestamps: false,
    versionKey: false,
  }
);

// Prevent accidental writes
influencerSchema.pre("save", () => {
  throw new Error("Influencer model is read-only in this service");
});
influencerSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"], () => {
  throw new Error("Influencer model is read-only in this service");
});

module.exports = mongoose.model("Influencer", influencerSchema);
