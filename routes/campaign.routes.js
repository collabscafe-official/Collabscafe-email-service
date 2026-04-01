const { Router } = require("express");
const {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  sendCampaign,
  getCampaignLogs,
  previewCampaign,
  previewAll,
  getTemplate,
} = require("../controllers/campaign.controller");

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get("/",                    wrap(listCampaigns));
router.post("/preview",            wrap(previewCampaign));
router.get("/preview/all",         wrap(previewAll));
router.get("/templates/:type",     wrap(getTemplate));
router.get("/:id",                 wrap(getCampaign));
router.post("/",          wrap(createCampaign));
router.patch("/:id",      wrap(updateCampaign));
router.delete("/:id",     wrap(deleteCampaign));
router.post("/:id/send",  wrap(sendCampaign));
router.get("/:id/logs",   wrap(getCampaignLogs));

module.exports = router;
