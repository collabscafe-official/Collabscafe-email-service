const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

// Cache loaded templates in memory
const cache = {};

/**
 * Substitute {{variable}} placeholders in any string. Unknown placeholders
 * (e.g. {{foo}} when "foo" is not a key in vars) are stripped, mirroring the
 * historical renderTemplate behavior so subjects never ship with raw {{}}.
 */
function renderString(str, vars = {}) {
  if (!str) return "";
  let out = str;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), value ?? "");
  }
  return out.replace(/{{\s*\w+\s*}}/g, "");
}

/**
 * Load an HTML template file and replace {{variable}} placeholders.
 * @param {string} templateName  File name without .html extension
 * @param {object} variables     Key-value map of replacements
 * @returns {string} Rendered HTML string
 */
function renderTemplate(templateName, variables = {}) {
  if (!cache[templateName]) {
    const filePath = path.join(TEMPLATES_DIR, `${templateName}.html`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Template not found: ${templateName}.html`);
    }
    cache[templateName] = fs.readFileSync(filePath, "utf8");
  }

  return renderString(cache[templateName], variables);
}

/**
 * Render the campaign body for one recipient. If campaign has customBody
 * (edited HTML), always use it; otherwise fall back to the on-disk template.
 *
 * @param campaign       Campaign document (audience drives variable shape)
 * @param recipient      Influencer doc (creator audience) OR Brand doc (brand audience)
 * @param audience       Explicit audience override; falls back to campaign.audience
 * @param brandContact   For brand audience only — the admin BrandTeamMember
 *                       document (or any team member) used to populate
 *                       contact_person / contact_first_name / contact_email.
 *                       May be null when no team member exists for the brand.
 */
function renderForCampaign(campaign, recipient, audience, brandContact) {
  const effectiveAudience = audience || campaign.audience || "creator";
  const vars = buildVariables(recipient, effectiveAudience, brandContact);

  // If campaign has custom HTML saved, use it for any audience.
  if (campaign.customBody && campaign.customBody.trim()) {
    return renderString(campaign.customBody, vars);
  }

  // Fallback: load creator template from file. Brand audience has no
  // pre-built templates in v1; if we reach here on a brand campaign, createCampaign
  // somehow let a non-custom slip through — return a minimal safe message rather
  // than crash the queue.
  if (effectiveAudience === "brand") {
    return `<p>Hello ${vars.contact_person || vars.brand_name || "there"},</p>`;
  }
  return renderTemplate(campaign.templateType, vars);
}

/**
 * Render the campaign subject line for one recipient. Same variable shape as
 * the body, so {{brand_name}} / {{contact_first_name}} / {{first_name}} all
 * work in the subject too.
 */
function renderSubjectForCampaign(campaign, recipient, audience, brandContact) {
  const effectiveAudience = audience || campaign.audience || "creator";
  const vars = buildVariables(recipient, effectiveAudience, brandContact);
  return renderString(campaign.subject || "", vars);
}

function buildVariables(recipient, audience, brandContact) {
  if (audience === "brand") {
    const brandName = recipient?.brand_name || "there";
    const cFirst = brandContact?.first_name || "";
    const cLast  = brandContact?.last_name  || "";
    const cFull  = [cFirst, cLast].filter(Boolean).join(" ").trim();
    // contact_person falls back to brand_name when no team member exists, per
    // the design decision — keeps salutations from rendering "Hi ," .
    const contactPerson = cFull || brandName;
    return {
      brand_name:         brandName,
      contact_person:     contactPerson,
      contact_first_name: cFirst || brandName,
      contact_last_name:  cLast,
      contact_email:      brandContact?.email || recipient?.email || "",
      email:              recipient?.email || "",
      // Generic aliases so the admin doesn't have to memorize brand-specific
      // names. first_name = contact's first name (falls back to brand_name),
      // name = full contact person (falls back to brand_name).
      first_name:         cFirst || brandName,
      name:               contactPerson,
      profile_url:        "https://collabscafe.com",
      custom_body:        "",
    };
  }
  // Default: creator audience.
  return {
    first_name:   recipient?.name || "Creator",
    CREATOR_NAME: recipient?.name || "Creator",
    name:         recipient?.name || "Creator",
    email:        recipient?.email || "",
    profile_url:  "https://creator.collabscafe.com",
    custom_body:  "",
  };
}

module.exports = {
  renderTemplate,
  renderForCampaign,
  renderSubjectForCampaign,
  renderString,
};
