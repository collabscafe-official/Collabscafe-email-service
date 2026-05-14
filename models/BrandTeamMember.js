const mongoose = require("mongoose");

// Read-only mirror of the brand_team_members collection in the main DB.
// Used to resolve "contact person" for brand campaigns — at send time, the
// queue looks up the admin team member (is_admin: true) for the brand and
// passes their first_name/last_name/email through to the template renderer.
//
// strict:false because the underlying documents carry many more fields
// (designation, linkedin_profile, phone, etc.) that we don't need here.
const brandTeamMemberSchema = new mongoose.Schema(
  {
    first_name: String,
    last_name: String,
    email: String,
    phone: String,
    designation: String,
    is_admin: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    is_deleted: { type: Boolean, default: false },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: "Brand" },
    created_date: Date,
    createdAt: Date,
    updatedAt: Date,
  },
  {
    collection: "brand_team_members", // must match exact main-DB collection name
    strict: false,
    timestamps: false,
    versionKey: false,
  }
);

// Prevent accidental writes from the email service.
brandTeamMemberSchema.pre("save", () => {
  throw new Error("BrandTeamMember model is read-only in this service");
});
brandTeamMemberSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"], () => {
  throw new Error("BrandTeamMember model is read-only in this service");
});

module.exports = mongoose.model("BrandTeamMember", brandTeamMemberSchema);
