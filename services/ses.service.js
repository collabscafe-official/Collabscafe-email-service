const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

let sesClient = null;

function getClient() {
  if (!sesClient) {
    sesClient = new SESClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return sesClient;
}

/**
 * Send a single email via AWS SES.
 * @param {object} opts
 * @param {string} opts.to         Recipient email address
 * @param {string} opts.subject    Email subject
 * @param {string} opts.htmlBody   HTML email body
 * @param {string} [opts.textBody] Plain-text fallback (auto-stripped from html if omitted)
 * @returns {Promise<string>} SES MessageId
 */
async function sendEmail({ to, subject, htmlBody, textBody }) {
  const fromAddress = `${process.env.SES_FROM_NAME || "Collabscafe"} <${process.env.SES_FROM_EMAIL}>`;

  const plainText = textBody || htmlBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const command = new SendEmailCommand({
    Source: fromAddress,
    Destination: { ToAddresses: [to] },
    // Reply-To = the From mailbox — Gmail downranks senders whose Reply-To
    // is missing or points to noreply@. Setting it explicitly is one of the
    // small signals that helps land in Primary.
    ReplyToAddresses: [process.env.SES_FROM_EMAIL],
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        Html: { Data: htmlBody, Charset: "UTF-8" },
        Text: { Data: plainText, Charset: "UTF-8" },
      },
    },
  });

  const response = await getClient().send(command);
  return response.MessageId;
}

module.exports = { sendEmail };
