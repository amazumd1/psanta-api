const express = require('express');
const router = express.Router();
const cleaningReportController = require('../controllers/cleaningReportController');

// GET cleaning reports
router.get('/', cleaningReportController.getCleaningReports);

module.exports = router;
