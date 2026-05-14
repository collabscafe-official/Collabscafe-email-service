const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

// Cache loaded templates in memory
const cache = {};

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

  let html = cache[templateName];

  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    html = html.replace(regex, value ?? "");
  }

  // Remove any unreplaced placeholders
  html = html.replace(/{{\s*\w+\s*}}/g, "");

  return html;
}

/**
 * Render template by campaign + recipient.
 * If campaign has customBody (edited HTML), always use it for ALL types.
 * Falls back to loading the .html file only if customBody is absent.
 *
 * @param campaign  Campaign document (must have `audience` to drive variable shape)
 * @param recipient Influencer doc (creator audience) OR Brand doc (brand audience)
 * @param audience  Explicit audience override; falls back to campaign.audience
 */
function renderForCampaign(campaign, recipient, audience) {
  const effectiveAudience = audience || campaign.audience || "creator";
  const vars = buildVariables(recipient, effectiveAudience);

  // If campaign has custom HTML saved, always use it (covers both custom
  // campaigns AND edited templates AND brand campaigns since v1 brand
  // campaigns only support templateType='custom' anyway).
  if (campaign.customBody && campaign.customBody.trim()) {
    let html = campaign.customBody;
    for (const [key, value] of Object.entries(vars)) {
      html = html.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), value ?? "");
    }
    // Clean up any unreplaced variables
    html = html.replace(/{{\s*\w+\s*}}/g, "");
    return html;
  }

  // Fallback: load creator template from file. Brand audience has no pre-built
  // templates in v1; if we reach here on a brand campaign something is wrong
  // (createCampaign enforces customBody for brand), so just return a minimal
  // safe message rather than throwing in the queue.
  if (effectiveAudience === "brand") {
    return `<p>Hello ${vars.brand_name || "there"},</p>`;
  }
  return renderTemplate(campaign.templateType, vars);
}

function buildVariables(recipient, audience) {
  if (audience === "brand") {
    return {
      brand_name: recipient?.brand_name || "there",
      email: recipient?.email || "",
      // Also expose a couple of generic aliases so an admin writing a brand
      // template doesn't have to memorize a separate variable name.
      name: recipient?.brand_name || "there",
      first_name: recipient?.brand_name || "there",
      profile_url: "https://collabscafe.com",
      custom_body: "",
    };
  }
  // Default: creator audience.
  return {
    first_name: recipient?.name || "Creator",
    CREATOR_NAME: recipient?.name || "Creator",
    name: recipient?.name || "Creator",
    email: recipient?.email || "",
    profile_url: "https://creator.collabscafe.com",
    custom_body: "",
  };
}

module.exports = { renderTemplate, renderForCampaign };
