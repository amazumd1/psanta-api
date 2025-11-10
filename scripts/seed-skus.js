// services/api/scripts/seed-skus.js
const mongoose = require('mongoose');
require('dotenv').config();
const Sku = require('../models/Sku');

const BASE = [
  { skuId:'SH-REFILL', name:'Shampoo (refill)',       gross_weight_g: 520, net_weight_g: 500, price:4.5, consumption_g_per_day: 30 },
  { skuId:'CD-REFILL', name:'Conditioner (refill)',   gross_weight_g: 520, net_weight_g: 500, price:4.5, consumption_g_per_day: 25 },
  { skuId:'BW-BOTTLE', name:'Body wash',              gross_weight_g: 530, net_weight_g: 500, price:4.0, consumption_g_per_day: 28 },
  { skuId:'HS-BOTTLE', name:'Hand soap',              gross_weight_g: 420, net_weight_g: 400, price:3.0, consumption_g_per_day: 20 },
  { skuId:'DS-BOTTLE', name:'Dish soap',              gross_weight_g: 520, net_weight_g: 500, price:3.5, consumption_g_per_day: 18 },
  { skuId:'TP-ROLL',   name:'Toilet paper',           gross_weight_g: 100, net_weight_g: 95,  price:0.6, consumption_g_per_day: 7  },
  { skuId:'PT-ROLL',   name:'Paper towels',           gross_weight_g: 165, net_weight_g: 160, price:1.2, consumption_g_per_day: 6  },
  { skuId:'TL-PACK',   name:'Trash liners',           gross_weight_g: 0,   net_weight_g: 0,   price:2.8, consumption_g_per_day: 0  },
  { skuId:'LD-BOTTLE', name:'Laundry detergent',      gross_weight_g: 820, net_weight_g: 800, price:6.0, consumption_g_per_day: 35 },
  { skuId:'CP-BOX12',  name:'Coffee pods (12)',       gross_weight_g: 0,   net_weight_g: 0,   price:6.5, consumption_g_per_day: 0  },
  { skuId:'TB-BOX25',  name:'Tea bags (25)',          gross_weight_g: 0,   net_weight_g: 0,   price:3.2, consumption_g_per_day: 0  },

  // Optional appliance/linen items (agar catalog me chahiye)
  { skuId:'TV-43',     name:'Smart TV',               gross_weight_g: 0,   net_weight_g: 0,   price:15,  consumption_g_per_day: 0 },
  { skuId:'MW-STD',    name:'Microwave',              gross_weight_g: 0,   net_weight_g: 0,   price:8,   consumption_g_per_day: 0 },
  { skuId:'VC-STD',    name:'Vacuum cleaner',         gross_weight_g: 0,   net_weight_g: 0,   price:12,  consumption_g_per_day: 0 },
  { skuId:'WM-STD',    name:'Washing machine',        gross_weight_g: 0,   net_weight_g: 0,   price:30,  consumption_g_per_day: 0 },
  { skuId:'IR-SET',    name:'Iron + board',           gross_weight_g: 0,   net_weight_g: 0,   price:4,   consumption_g_per_day: 0 },
  { skuId:'SP-SET6',   name:'Spoon set (6)',          gross_weight_g: 0,   net_weight_g: 0,   price:3,   consumption_g_per_day: 0 },
  { skuId:'CT-SET24',  name:'Cutlery set (24)',       gross_weight_g: 0,   net_weight_g: 0,   price:6,   consumption_g_per_day: 0 },
  { skuId:'DW-SET4',   name:'Dinnerware (4)',         gross_weight_g: 0,   net_weight_g: 0,   price:7,   consumption_g_per_day: 0 },
  { skuId:'BS-SET',    name:'Bedsheet set',           gross_weight_g: 0,   net_weight_g: 0,   price:5,   consumption_g_per_day: 0 },
  { skuId:'TW-SET4',   name:'Bath towel set (4)',     gross_weight_g: 0,   net_weight_g: 0,   price:6,   consumption_g_per_day: 0 },
];

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Mongo connected');

    for (const s of BASE) {
      await Sku.updateOne({ skuId: s.skuId }, { $set: s }, { upsert: true });
      console.log('upsert', s.skuId);
    }

    console.log('🎉 Done seeding SKUs');
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('❌ Seed error:', e);
    process.exit(1);
  }
})();
