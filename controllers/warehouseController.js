const Warehouse = require('../models/Warehouse');

exports.list = async (req, res) => {
  try { const rows = await Warehouse.find({}).lean();
        res.json({ success:true, data: rows }); }
  catch (e) { res.status(500).json({ success:false, message: e.message }); }
};

exports.create = async (req, res) => {
  try { const doc = await Warehouse.create(req.body);
        res.status(201).json({ success:true, data: doc }); }
  catch (e) { res.status(400).json({ success:false, message: e.message }); }
};

exports.get = async (req, res) => {
  try { const doc = await Warehouse.findById(req.params.id);
        if (!doc) return res.status(404).json({ success:false, message:'Not found' });
        res.json({ success:true, data: doc }); }
  catch (e) { res.status(400).json({ success:false, message: e.message }); }
};

exports.update = async (req, res) => {
  try { const doc = await Warehouse.findByIdAndUpdate(req.params.id, req.body, { new:true });
        if (!doc) return res.status(404).json({ success:false, message:'Not found' });
        res.json({ success:true, data: doc }); }
  catch (e) { res.status(400).json({ success:false, message: e.message }); }
};

exports.remove = async (req, res) => {
  try { const doc = await Warehouse.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ success:false, message:'Not found' });
        res.status(204).end(); }
  catch (e) { res.status(400).json({ success:false, message: e.message }); }
};
