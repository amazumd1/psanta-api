// services/api/server.js  — CommonJS only, ESM routes via dynamic import

// CommonJS server
const express = require('express');
const mongoose = require('mongoose');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const net = require('net');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
console.log('ENV loaded from', path.resolve(__dirname, '.env'), 'MONGODB_URI?', !!process.env.MONGODB_URI);
const { auth } = require('./middleware/auth');
const { requireRole } = require('./middleware/roles');
const bcrypt = require('bcryptjs');
const customerOrders = require('./src/routes/customer/orders.route');
const cookieParser = require('cookie-parser');
// If FIREBASE_SERVICE_ACCOUNT_JSON is provided, write it to /tmp and point GOOGLE_APPLICATION_CREDENTIALS
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const saPath = path.join('/tmp', 'firebase_sa.json');
  try {
    fs.writeFileSync(saPath, process.env.FIREBASE_SERVICE_ACCOUNT_JSON, { encoding: 'utf8' });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    console.log('✅ Wrote Firebase SA to', saPath);
  } catch (e) {
    console.error('❌ Failed to write Firebase SA:', e.message);
  }
}



const app = express();
app.set('trust proxy', 1); // behind Render/Proxy

const PORT = Number(process.env.PORT) || 5000;

const cors = require('cors');
// (aapka existing corsCfg yahin rahe)
// preflight ok


// const DEV_PORTS = [3000, 3001, 3002, 3003, 3004, 3007, 3008, 5173, 5174, 5175, 5176];
// const ALLOWED_ORIGINS = new Set(
//   DEV_PORTS.flatMap(p => [`http://localhost:${p}`, `http://127.0.0.1:${p}`])
// );

// const corsCfg = {
//   origin: (origin, cb) => {
//     if (!origin || ALLOWED_ORIGINS.has(origin) ||
//       (process.env.NODE_ENV !== 'production' &&
//         (origin?.startsWith('http://localhost:') || origin?.startsWith('http://127.0.0.1:')))) {
//           return cb(null, true);
//         }
//         return cb(null, false);
//       },
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//  allowedHeaders: [
//     'Content-Type','Authorization','x-auth-token','X-Requested-With',
//     'Idempotency-Key','idempotency-key'
//   ],
//   exposedHeaders: ['Content-Length','Content-Type','Idempotency-Key'],
//   maxAge: 600,
// };


function safeUse(mount, mod) {
  // ESM/CJS normalize
  const handler = mod && (mod.default || mod);
  const isRouter =
    typeof handler === 'function' ||
    (handler && typeof handler.handle === 'function');

  if (!isRouter) {
    console.error('❌ Skipping mount:', mount, 'Invalid export:', handler);
    return; // skip instead of crashing
  }
  app.use(mount, handler);
}

app.use(cookieParser(process.env.COOKIE_SECRET || undefined));

// app.use(cors(corsCfg));
// app.options('/(.*)', cors(corsCfg));

// --- CORS allowlist via env ---
const DEV_PORTS = [3000, 3001, 3002, 3003, 3004, 3007, 3008, 5173, 5174, 5175, 5176];
const DEV_ORIGINS = new Set(DEV_PORTS.flatMap(p => [
  `http://localhost:${p}`, `http://127.0.0.1:${p}`
]));

// comma-separated list: https://your-front.vercel.app,https://your-warehouse.netlify.app
const PROD_ALLOW = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsCfg = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (DEV_ORIGINS.has(origin)) return cb(null, true);
    if (PROD_ALLOW.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  exposedHeaders: ['Content-Length', 'Content-Type', 'Idempotency-Key'],
  maxAge: 600,
};
// app.use(cors(corsCfg));
app.use(cors(corsCfg));
app.options('*', cors(corsCfg));

// ✅ mount raw body for PayPal webhook verification
const paypalWebhook = require('./src/routes/payments/paypal.webhook.route');
app.post('/api/payments/paypal/webhook',
  express.raw({ type: 'application/json' }),
  paypalWebhook
);

/* -------------------- Body parsing -------------------- */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* -------------------- Static -------------------- */
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* -------------------- Health -------------------- */
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'PropertySanta Cleaner API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

/* -------------------- Quick route list -------------------- */
app.get('/__debug/routes', (req, res) => {
  const out = [];
  app._router.stack.forEach((m) => {
    if (m.route?.path) {
      out.push({ method: Object.keys(m.route.methods)[0].toUpperCase(), path: m.route.path });
    } else if (m.name === 'router' && m.regexp) {
      const mount = m.regexp.toString();
      (m.handle.stack || []).forEach((r) => {
        if (r.route?.path) out.push({ mount, method: Object.keys(r.route.methods)[0].toUpperCase(), path: r.route.path });
      });
    }
  });
  res.json(out);
});

app.get('/__debug/wh-model', (req, res) => {
  const M = require('./src/models/WarehouseOrder');
  res.json({
    file: require.resolve('./src/models/WarehouseOrder'),
    enum: M.schema.path('status').enumValues,
  });
});

/* -------------------- ESM route helper -------------------- */
async function mountESMRoutes(app) {
  const add = async (mount, relPath) => {
    const full = path.join(__dirname, relPath);
    console.log('🔸 Loading ESM route:', full);
    const mod = await import(pathToFileURL(full).href);
    app.use(mount, mod.default || mod);
    console.log('✅ Mounted:', mount, '←', relPath);
  };
  await add('/api/print', './src/routes/print.route.js');
  app.use('/api/wh', auth, requireRole(['admin', 'warehouse']));
  await add('/api/wh', './src/routes/wh/index.route.js');
  await add('/api/wh', './src/routes/wh/pack.route.js');
  await add('/api/wh', './src/routes/wh/orders.util.route.js');
  await add('/api/wh', './src/routes/wh/jobs.route.js');
  await add('/api/wh', './src/routes/wh/learning.route.js');
  await add('/api/wh', './src/routes/wh/reco.route.js');
  await add('/api/orders', './src/routes/orders.weight.route.js');
}

/* -------------------- CJS routes -------------------- */
const authRoutes = require('./routes/auth');
const taskRoutes = require('./routes/tasks');
// const aiRoutes = require('./routes/ai');
const propertyRoutes = require('./routes/properties');
const userRoutes = require('./routes/userRoutes');


app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
// app.use('/api/ai', aiRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/users', userRoutes);
app.use('/api/host', require('./routes/host.onboarding'));
app.use('/api/admin', require('./routes/admin.orders'));
app.use('/api/pricing', require('./routes/pricing.routes'));

require('./src/routes/admin/suggestions.route.js')(app);
// app.use('/api/alerts', require('./src/routes/alerts.route'));
// app.use('/api/subscriptions', require('./src/routes/subscriptions.route'));
// // app.use('/api/wh/topup', require('./src/routes/wh/topup.route'));
// app.use('/api/ics', require('./src/routes/ics.route'));
// app.use('/api/payments', require('./src/routes/payments/paypal.route'));
// app.use('/api/invoices', require('./src/routes/invoices.route'));
// app.use('/api/jobs', require('./src/routes/jobs.route'));
// app.use('/api/offers', require('./src/routes/offers.route'));
// app.use('/api/config', require('./src/routes/config.route'));
// app.use('/api/ceo', require('./src/routes/ceo.route'));
// app.use('/api/customer/summary', require('./src/routes/customer/summary.route'));
// app.use('/api/customer/orders', require('./src/routes/customer/orders.route'));
// app.use('/api/customer/properties', require('./src/routes/customer/properties.route'));
// app.use('/api/customer/tasks', require('./src/routes/customer/tasks.route'));
// app.use('/api/customer/messages', require('./src/routes/customer/messages.route'));



safeUse('/api/alerts', require('./src/routes/alerts.route'));
safeUse('/api/subscriptions', require('./src/routes/subscriptions.route'));
safeUse('/api/wh/topup', require('./src/routes/wh/topup.route'));
safeUse('/api/ics', require('./src/routes/ics.route'));
safeUse('/api/payments', require('./src/routes/payments/paypal.route'));
safeUse('/api/invoices', require('./src/routes/invoices.route'));
safeUse('/api/jobs', require('./src/routes/jobs.route'));
safeUse('/api/offers', require('./src/routes/offers.route'));
safeUse('/api/config', require('./src/routes/config.route'));
safeUse('/api/ceo', require('./src/routes/ceo.route'));
safeUse('/api/customer/summary', require('./src/routes/customer/summary.route'));
safeUse('/api/customer/orders', require('./src/routes/customer/orders.route'));
safeUse('/api/customer/properties', require('./src/routes/customer/properties.route'));
safeUse('/api/customer/tasks', require('./src/routes/customer/tasks.route'));
safeUse('/api/customer/autopay', require('./src/routes/customer/autopay.route'));
// safeUse('/api/payments/paypal/webhook', require('./src/routes/payments/paypal.webhook.route'));
safeUse('/api/users/me', require('./src/routes/users.me.route'));
safeUse('/api/payroll', require('./src/routes/payroll.route'));

const receiptsRouter = require("./routes/receipts.routes");
app.use("/api/receipts", receiptsRouter);





/* -------------------- Debug helpers -------------------- */
app.get('/debug/properties', async (req, res) => {
  try {
    const Property = require('./models/Property');
    const properties = await Property.find({});
    res.json({ success: true, count: properties.length, properties });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

app.get('/__debug/wo-model', (req, res) => {
  try {
    const M = require('./src/models/WarehouseOrder');
    const resolved = require.resolve('./src/models/WarehouseOrder');

    res.json({
      resolvedFile: resolved,
      orderIdType: M.schema.path('orderId')?.instance,
      statusEnum: M.schema.path('status')?.enumValues,
      keys: Object.keys(M.schema.paths),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});




/* -------------------- Port finder -------------------- */
const findAvailablePort = async (startPort) => {
  const port = Number(startPort);
  if (isNaN(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${startPort}`);

  return new Promise((resolve, reject) => {
    const tester = net
      .createServer()
      .once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          tester.close();
          findAvailablePort(port + 1).then(resolve).catch(reject);
        } else reject(err);
      })
      .once('listening', () => {
        const { port: actual } = tester.address();
        tester.close(() => resolve(actual));
      })
      .listen(port);
  });
};

/* -------------------- Frontend env updater -------------------- */
const FRONTENDS = [
  { name: 'admin', kind: 'next', envPath: path.resolve(__dirname, '../../apps/admin/.env.local') },
  { name: 'cleaner', kind: 'next', envPath: path.resolve(__dirname, '../../apps/cleaner/.env.local') },
  { name: 'customer', kind: 'next', envPath: path.resolve(__dirname, '../../apps/customer/.env.local') },
  { name: 'frontPage', kind: 'vite', envPath: path.resolve(__dirname, '../../apps/frontPage/.env.local') },
  { name: 'warehouse', kind: 'vite', envPath: path.resolve(__dirname, '../../apps/warehouse/.env.local') },
  { name: 'ops-app', kind: 'vite', envPath: path.resolve(__dirname, '../../apps/ops-app/.env.local') },
];

const envLineFor = (kind, apiUrl) => (kind === 'vite' ? `VITE_API_BASE_URL=${apiUrl}\n` : `NEXT_PUBLIC_API_URL=${apiUrl}\n`);

const ensureDir = (p) => {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const updateFrontendEnv = (port) => {
  const apiUrl = `http://localhost:${port}/api`;
  FRONTENDS.forEach((f) => {
    try {
      const appDir = path.dirname(f.envPath);
      if (!fs.existsSync(appDir)) return;

      ensureDir(f.envPath);
      let content = fs.existsSync(f.envPath) ? fs.readFileSync(f.envPath, 'utf8') : '';

      const key = f.kind === 'vite' ? 'VITE_API_BASE_URL' : 'NEXT_PUBLIC_API_URL';
      const line = envLineFor(f.kind, apiUrl);

      if (content.includes(`${key}=`)) {
        content = content.replace(new RegExp(`${key}=.*`, 'g'), line.trim());
      } else {
        content = (content ? content.trim() + '\n' : '') + line.trim();
      }
      content = content.endsWith('\n') ? content : content + '\n';

      fs.writeFileSync(f.envPath, content, 'utf8');
      console.log(`✅ Updated ${f.name} env: ${f.envPath} → ${key}=${apiUrl}`);
    } catch (e) {
      console.error(`❌ Failed to update ${f.name} environment:`, e);
    }
  });
};

/* -------------------- Mongo -------------------- */
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
  await require('./src/models/Job').syncIndexes();

};

/* -------------------- Seed (idempotent) -------------------- */
const initializeDatabase = async () => {
  try {
    console.log('🔄 Starting database initialization...');
    const User = require('./models/User');
    const Property = require('./models/Property');

    const cleanerEmail = 'elite@gmail.com';
    const customerEmail = 'john.smith@email.com';
    const adminEmail = 'admin@gmail.com';

    // hash once for each role (updateOne pre-save hooks don't run)
    const hash = (pwd) => bcrypt.hash(pwd, 10);
    const [cleanerHash, customerHash, adminHash] = await Promise.all([
      hash('1qaz!QAZ'),
      hash('1qaz!QAZ'),
      hash('admin123'),
    ]);

    const upsertUser = async (query, doc) => {
      await User.updateOne(query, { $setOnInsert: doc }, { upsert: true });
    };

    await upsertUser(
      { email: cleanerEmail },
      {
        name: 'elite cleaner',
        email: cleanerEmail,
        password: cleanerHash, // ✅ hashed
        phone: '+1 (555) 123-4567',
        role: 'cleaner',
        rating: 4.8,
        specialties: ['Deep Cleaning', 'Kitchen Sanitization'],
        availability: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
      }
    );

    await upsertUser(
      { email: customerEmail },
      {
        name: 'John Smith',
        email: customerEmail,
        password: customerHash, // ✅ hashed
        phone: '+1 (555) 987-6543',
        role: 'customer',
      }
    );

    await upsertUser(
      { email: adminEmail },
      {
        name: 'PropertySanta Admin',
        email: adminEmail,
        password: adminHash, // ✅ hashed (duplicate plain key removed)
        phone: '+1 (555) 000-0000',
        role: 'admin',
      }
    );

    const existingProperties = await Property.countDocuments();
    if (existingProperties === 0) {
      const customer = await User.findOne({ email: customerEmail }).lean();
      const customerId = customer ? customer._id : undefined;

      const sampleProperty = new Property({
        propertyId: 'EO-1208-RDU',
        name: 'Enchanted Oaks House',
        address: '1208 Enchanted Oaks Drive, Raleigh, NC 27606',
        type: 'house',
        squareFootage: 1945,
        manual: {
          title: 'Live Cleaning & Maintenance Manual',
          content:
            'Detailed manual content goes here. Focus on kitchen and bathrooms. Use special cleaner for granite countertops.',
        },
        roomTasks: [
          { roomType: 'bedroom', tasks: [{ description: 'make the bed', Regular: 'week' }, { description: 'Clean floor', Regular: 'week' }] },
          { roomType: 'bathroom', tasks: [{ description: 'clean the floor', Regular: '2week' }] },
        ],
        customer: customerId,
        cycle: 'weekly',
        isActive: true,
      });
      await sampleProperty.save();
      console.log('✅ Sample property created successfully.');
    }
  } catch (error) {
    console.error('❌ Error initializing sample data:', error);
  }
};





/* -------------------- Start -------------------- */
const startServer = async () => {
  await connectDB();

  // --- WO model compile guard ---
  try {
    const mongoose = require('mongoose');
    const canonicalPath = require('path').resolve(__dirname, './src/models/WarehouseOrder');

    const existing = mongoose.models.WarehouseOrder;
    if (existing) {
      const t = existing.schema.path('orderId')?.instance;
      if (t !== 'String') {
        console.warn('⚠️ Recompiling WarehouseOrder with String orderId (was:', t, ')');
        mongoose.deleteModel('WarehouseOrder');
        delete require.cache[require.resolve(canonicalPath)];
      }
    }
    require('./src/models/WarehouseOrder'); // force-load canonical
    const check = mongoose.models.WarehouseOrder?.schema.path('orderId')?.instance;
    console.log('✅ WarehouseOrder.orderId type:', check);
  } catch (e) {
    console.error('❌ WO model fix failed:', e);
  }

  // --- seed + routes mount ---
  await initializeDatabase();
  await mountESMRoutes(app);

  // ✅ Explicit CJS mounts for messages (no ESM ambiguity)
  safeUse('/api/customer/messages', require('./src/routes/customer/messages.route'));
  safeUse('/api/admin/messages', require('./src/routes/admin/messages.route'));
  console.log('✅ Mounted via safeUse: /api/customer/messages* and /api/admin/messages*');

  // --- error handler MUST be after all mounts ---
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ ok: false, error: err.message });
  });

  // --- create server + socket.io attach ---
  const http = require('http');
  const httpServer = http.createServer(app);
  const { attachIO } = require('./src/server/socket');
  attachIO(httpServer);

  // --- bind port: prod = exact PORT; dev = findAvailablePort ---
  const isProd = process.env.NODE_ENV === 'production';
  const bindPort = isProd ? PORT : await findAvailablePort(PORT);

  httpServer.listen(bindPort, () => {
    console.log(`🚀 Server running on port ${bindPort}`);
    console.log(`📱 API available at http://localhost:${bindPort}`);
    console.log(`🔗 Health check: http://localhost:${bindPort}/health`);
    if (!isProd) {
      updateFrontendEnv(bindPort);
      if (bindPort !== PORT) console.log(`⚠️ Port ${PORT} was in use, using ${bindPort}`);
    }
  });
};

startServer();


