// services/api/scripts/seed-admin.js
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User'); // adjust if different

(async () => {
  try {
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) throw new Error('Missing MONGODB_URI or MONGO_URI');
await mongoose.connect(uri);
    const email = 'admin@gmail.com';
    const plain = 'admin123';

    let u = await User.findOne({ email });
    if (!u) {
      const hash = await bcrypt.hash(plain, 10);
      u = await User.create({
        email,
        password: hash,
        role: 'admin',
        name: 'Admin'
      });
      console.log('✅ Seeded admin:', u.email);
    } else {
      console.log('ℹ️ Admin already exists:', u.email);
    }
  } catch (e) {
    console.error('Seed error:', e);
    process.exit(1);
  }
  process.exit(0);
})();
