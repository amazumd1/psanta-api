// services/api/src/controllers/jobs.controller.js (snippet)
const Job = require('../models/Job');

exports.createJob = async (req, res, next) => {
  try {
    const job = await Job.create(req.body); // triggers pre('save') => jobId
    return res.json({ ok: true, data: job });
  } catch (e) { next(e); }
};
