// Send ONE plain email (support / warning / follow-up) through our SES sender,
// wrapped in templates/custom.html. Run from the repo root:
//
//   node scripts/send-one.js --to someone@x.com --subject "..." --body body.txt          (preview only)
//   node scripts/send-one.js --to someone@x.com --subject "..." --body body.txt --send   (sends)
//
// body.txt: plain text. Blank line = new paragraph, lines starting with "- " = bullets,
// **bold** works. Without --send it only writes the rendered HTML next to the body file.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { renderTemplate } = require("../services/template.service");
const { sendEmail } = require("../services/ses.service");

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const to = arg("to"), subject = arg("subject"), bodyFile = arg("body");
if (!to || !subject || !bodyFile) {
  console.error('Usage: node scripts/send-one.js --to <email> --subject "<subject>" --body <file.txt> [--send]');
  process.exit(1);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
const blocks = fs.readFileSync(bodyFile, "utf8").replace(/\r/g, "").trim().split(/\n\s*\n/);
const html = blocks.map((b) => {
  const lines = b.split("\n");
  if (lines.every((l) => l.startsWith("- "))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
  return `<p>${lines.map(inline).join("<br />")}</p>`;
}).join("\n");

const htmlBody = renderTemplate("custom", { custom_body: html, email: encodeURIComponent(to) });
const previewPath = path.join(path.dirname(bodyFile), path.basename(bodyFile, path.extname(bodyFile)) + ".preview.html");
fs.writeFileSync(previewPath, htmlBody);
console.log(`Preview: ${previewPath}`);

if (!args.includes("--send")) { console.log("Dry run. Add --send to send."); process.exit(0); }
sendEmail({ to, subject, htmlBody })
  .then((id) => { console.log(`Sent to ${to}. SES MessageId: ${id}`); process.exit(0); })
  .catch((e) => { console.error(`Send failed: ${e.name}: ${e.message}`); process.exit(1); });
