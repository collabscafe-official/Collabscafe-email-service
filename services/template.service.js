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
 * Render template by campaign.
 * If campaign has customBody (edited HTML), always use it for ALL types.
 * Falls back to loading the .html file only if customBody is absent.
 */
function renderForCampaign(campaign, influencer) {
  const vars = buildVariables(influencer);

  // If campaign has custom HTML saved, always use it
  // This covers both custom campaigns AND edited templates
  if (campaign.customBody && campaign.customBody.trim()) {
    let html = campaign.customBody;
    for (const [key, value] of Object.entries(vars)) {
      html = html.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), value ?? "");
    }
    // Clean up any unreplaced variables
    html = html.replace(/{{\s*\w+\s*}}/g, "");
    return html;
  }

  // Fallback: load from file (safety net only)
  return renderTemplate(campaign.templateType, vars);
}

function buildVariables(influencer) {
  return {
    first_name: influencer.name || "Creator",
    CREATOR_NAME: influencer.name || "Creator",
    email: influencer.email || "",
    profile_url: "https://creator.collabscafe.com",
    custom_body: "",
  };
}

module.exports = { renderTemplate, renderForCampaign };
