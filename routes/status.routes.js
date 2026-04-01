const { Router } = require("express");
const { health, getStats } = require("../controllers/status.controller");

const router = Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get("/health", wrap(health));
router.get("/status", wrap(getStats));

module.exports = router;
