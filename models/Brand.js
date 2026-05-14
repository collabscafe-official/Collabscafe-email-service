const mongoose = require("mongoose");

// Read-only mirror of the brands collection in the main DB.
// Only fields needed for email targeting and template variables are declared.
//
// Audience field on Campaign decides whether to query this model vs Influencer
// — when audience='brand', queue.service.buildAudience hits this collection.
//
// strict:false allows the underlying brand documents to carry many more fields
// (about, website, social handles, etc.) without crashing this read.
const brandSchema = new mongoose.Schema(
  {
    brand_name: String,
    email: String,
    category: String,           // industry (Beauty, Fashion, Food, Tech, etc.)
    campaign_goal: String,      // Awareness, Sales, UGC Content, etc.
    country: String,
    city: String,
    is_active: { type: Boolean, default: true },
    is_deleted: { type: Boolean, default: false },
    is_email_verified: { type: Boolean, default: false },
    is_profile_completed: { type: Boolean, default: false },
    is_approved_by_admin: { type: Boolean, default: false },
    created_date: Date,
    createdAt: Date,
    updatedAt: Date,
  },
  {
    collection: "brands", // must match the exact collection name in main DB
    strict: false,
    timestamps: false,
    versionKey: false,
  }
);

// Prevent accidental writes from the email service.
brandSchema.pre("save", () => {
  throw new Error("Brand model is read-only in this service");
});
brandSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"], () => {
  throw new Error("Brand model is read-only in this service");
});

module.exports = mongoose.model("Brand", brandSchema);
