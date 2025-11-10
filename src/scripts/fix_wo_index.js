// node services/api/src/scripts/fix_wo_index.js
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;
    const coll = db.collection('warehouseorders');

    const idxs = await coll.indexes();
    const target = idxs.find(i => i.key && i.key.orderId === 1);
    if (target) {
      console.log('Dropping index:', target.name);
      await coll.dropIndex(target.name);
    } else {
      console.log('No existing orderId index');
    }

    console.log('Creating partial unique index on orderId (type string)…');
    await coll.createIndex(
      { orderId: 1 },
      { unique: true, partialFilterExpression: { orderId: { $type: 'string' } } }
    );

    console.log('✅ Done');
    process.exit(0);
  } catch (e) {
    console.error('❌ Failed:', e);
    process.exit(1);
  }
})();
