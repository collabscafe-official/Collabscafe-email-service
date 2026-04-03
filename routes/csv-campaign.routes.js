const { Router } = require("express");
const {
  upload,
  parseFile,
  listCsvCampaigns,
  getCsvCampaign,
  getCsvCampaignRecipients,
  createCsvCampaign,
  updateCsvCampaign,
  deleteCsvCampaign,
  sendCsvCampaign,
  pauseCsvCampaignController,
  resumeCsvCampaignController,
  stopCsvCampaignController,
} = require("../controllers/csv-campaign.controller");

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post("/parse",         upload.single("file"), wrap(parseFile));
router.get("/",               wrap(listCsvCampaigns));
router.post("/",              wrap(createCsvCampaign));
router.get("/:id/recipients", wrap(getCsvCampaignRecipients));
router.get("/:id",            wrap(getCsvCampaign));
router.patch("/:id",          wrap(updateCsvCampaign));
router.delete("/:id",         wrap(deleteCsvCampaign));
router.post("/:id/send",      wrap(sendCsvCampaign));
router.post("/:id/pause",     wrap(pauseCsvCampaignController));
router.post("/:id/resume",    wrap(resumeCsvCampaignController));
router.post("/:id/stop",      wrap(stopCsvCampaignController));

module.exports = router;
