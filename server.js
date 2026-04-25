// services/api/server.js  — CommonJS only, ESM routes via dynamic import

// CommonJS server
const express = require('express');
const mongoose = require('mongoose');
// const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const net = require('net');
// require('dotenv').config({ path: path.resolve(__dirname, '.env') });
// console.log('ENV loaded from', path.resolve(__dirname, '.env'), 'MONGODB_URI?', !!process.env.MONGODB_URI);

const { firebaseAuth, requireOpsAdmin } = require("./middleware/firebaseAuth");
const inviteRoutes = require("./routes/invite.routes");
const { loadLocalEnv } = require("./lib/loadLocalEnv");
const { assertRuntimeEnv } = require("./lib/runtimeGuard");

loadLocalEnv();
assertRuntimeEnv();

const generalDataGmailRoutes = require("./routes/generalData.gmail.routes");
const internalLegacyGmailReceiptsRoutes = require("./routes/internal/legacyGmailReceipts.routes");
const retailGmailReceiptsRoutes = require("./routes/retailReceipts.gmail.routes");
const businessIntelligenceRoutes = require("./routes/businessIntelligence.routes");
const businessIntelligenceWebhookRoutes = require("./routes/businessIntelligenceWebhook.routes");

const { startRetailReceiptScheduler } = require("./lib/retailReceiptScheduler");

const {
  requestContext,
  securityHeaders,
  httpAuditLogger,
  blockDebugInProduction,
} = require("./middleware/requestHardening");
const { makeRateLimiter } = require("./middleware/rateLimit");

const { auth } = require('./middleware/auth');
const { requireRole } = require('./middleware/roles');
const bcrypt = require('bcryptjs');
const customerOrders = require('./src/routes/customer/orders.route');
const psRequests = require("./routes/psRequests");
const psStr = require("./routes/psStr");
const { requireTenantAccess, requireTenantRole } = require("./middleware/tenantAccess");




const cookieParser = require('cookie-parser');



const app = express();
app.disable("x-powered-by");
app.set('trust proxy', 1); // behind Render/Proxy

app.use(requestContext);
app.use(securityHeaders);
app.use(httpAuditLogger);

const authLimiter = makeRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 40 : 200,
  keyPrefix: "auth",
});

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


// function safeUse(mount, mod) {
//   // ESM/CJS normalize
//   const handler = mod && (mod.default || mod);
//   const isRouter =
//     typeof handler === 'function' ||
//     (handler && typeof handler.handle === 'function');

//   if (!isRouter) {
//     console.error('❌ Skipping mount:', mount, 'Invalid export:', handler);
//     return; // skip instead of crashing
//   }
//   app.use(mount, handler);
// }

function safeUse(mount, ...handlers) {
  const normalized = handlers
    .map((h) => (h && (h.default || h)))
    .filter(Boolean);

  if (!normalized.length) {
    console.error("❌ safeUse skipped:", mount, "no handlers");
    return;
  }

  const ok = normalized.every(
    (h) => typeof h === "function" || typeof h?.handle === "function"
  );

  if (!ok) {
    console.error("❌ safeUse skipped:", mount, "invalid handler(s)");
    return;
  }

  app.use(mount, ...normalized);
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
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const PROPERTY_SANTA_RE = /^https:\/\/([a-z0-9-]+\.)?propertysanta\.com$/i;

const VERCEL_PREVIEW_RE =
  /^https:\/\/psanta-(ops|customer|api|warehouse|cleaner|admin)(?:-[a-z0-9-]+)?\.vercel\.app$/i;

const corsCfg = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    const cleanOrigin = String(origin).trim().replace(/\/$/, '');

    if (DEV_ORIGINS.has(cleanOrigin)) return cb(null, true);
    if (PROD_ALLOW.includes(cleanOrigin)) return cb(null, true);
    if (PROPERTY_SANTA_RE.test(cleanOrigin)) return cb(null, true);
    if (VERCEL_PREVIEW_RE.test(cleanOrigin)) return cb(null, true);

    return cb(null, false);
  },
  credentials: true,
  exposedHeaders: ['Content-Length', 'Content-Type', 'Idempotency-Key'],
  maxAge: 600,
};

app.use(cors(corsCfg));
app.options('*', cors(corsCfg));

// ✅ mount raw body for PayPal webhook verification
const paypalWebhook = require('./src/routes/payments/paypal.webhook.route');
app.post('/api/payments/paypal/webhook',
  express.raw({ type: 'application/json' }),
  paypalWebhook
);

/* -------------------- Body parsing -------------------- */
app.use(express.json({ limit: '25mb' }));
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
// ✅ Home (so Vercel "/" doesn't 404)
app.get("/", (req, res) => {
  res.status(200).send("PSanta API is running ✅  Try /health");
});

// ✅ Favicon (browser auto-hits it)
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

/* -------------------- Quick route list -------------------- */
app.get('/__debug/routes', blockDebugInProduction, (req, res) => {
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

app.get('/__debug/wh-model', blockDebugInProduction, (req, res) => {
  const M = require('./src/models/WarehouseOrder');
  res.json({
    file: require.resolve('./src/models/WarehouseOrder'),
    enum: M.schema.path('status').enumValues,
  });
});

/* -------------------- ESM route helper -------------------- */
// async function mountESMRoutes(app) {
//   const add = async (mount, relPath) => {
//     const full = path.join(__dirname, relPath);
//     console.log('🔸 Loading ESM route:', full);
//     const mod = await import(pathToFileURL(full).href);
//     app.use(mount, mod.default || mod);
//     console.log('✅ Mounted:', mount, '←', relPath);
//   };
//   await add('/api/print', './src/routes/print.route.js');
//   app.use('/api/wh', auth, requireRole(['admin', 'warehouse']));
//   await add('/api/wh', './src/routes/wh/index.route.js');
//   await add('/api/wh', './src/routes/wh/pack.route.js');
//   await add('/api/wh', './src/routes/wh/orders.util.route.js');
//   await add('/api/wh', './src/routes/wh/jobs.route.js');
//   await add('/api/wh', './src/routes/wh/learning.route.js');
//   await add('/api/wh', './src/routes/wh/reco.route.js');
//   await add('/api/orders', './src/routes/orders.weight.route.js');
// }

/* -------------------- Route mounts (Vercel-safe, no dynamic import) -------------------- */
function mountRoutes() {
  // print
  safeUse("/api/print", require("./src/routes/print.route.js"));

  // warehouse (protected)
  safeUse("/api/wh", auth, requireRole(["admin", "warehouse"]), require("./src/routes/wh/index.route.js"));
  safeUse("/api/wh", auth, requireRole(["admin", "warehouse"]), require("./src/routes/wh/pack.route.js"));
  safeUse("/api/wh", auth, requireRole(["admin", "warehouse"]), require("./src/routes/wh/orders.util.route.js"));
  safeUse("/api/wh", auth, requireRole(["admin", "warehouse"]), require("./src/routes/wh/jobs.route.js"));
  safeUse("/api/wh", auth, requireRole(["admin", "warehouse"]), require("./src/routes/wh/learning.route.js"));
  safeUse("/api/wh", auth, requireRole(["admin", "warehouse"]), require("./src/routes/wh/reco.route.js"));

  // orders weight routes
  safeUse("/api/orders", require("./src/routes/orders.weight.route.js"));
}

/* -------------------- CJS routes -------------------- */
const authRoutes = require('./routes/auth');
const taskRoutes = require('./routes/tasks');
const aiRoutes = require('./routes/ai');
const propertyRoutes = require('./routes/properties');
const userRoutes = require('./routes/userRoutes');
const businessRoutes = require("./routes/business.routes");
const workspaceRoutes = require("./routes/workspace.routes");
const billingRoutes = require("./routes/billing.routes");

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/tasks', auth, requireTenantAccess, taskRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/properties', auth, propertyRoutes);
app.use('/api/users', userRoutes);
app.use("/api/business", auth, requireTenantAccess, businessRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/billing", auth, billingRoutes);
app.use('/api/host', require('./routes/host.onboarding'));
app.use('/api/admin', require('./routes/admin.orders'));
app.use('/api/pricing', require('./routes/pricing.routes'));
app.use("/api/invite", firebaseAuth, requireOpsAdmin, inviteRoutes);
app.use("/api/tx", auth, require("./routes/tx.screenshot"));
app.use("/api/uploads", auth, require("./routes/cloudinary.upload"));
app.use("/api/finance", auth, require("./routes/finance.transactions"));
app.use("/api/pc/str", require("./routes/psStr")); // frontend fallbacks
app.use('/api/pc', require('./routes/pc'));

// app.use("/api/ps/str", psStr);          // ✅ ADD THIS (before /api/ps)
app.use("/api/ps", require("./routes/pc"));
app.use("/api/ps", psRequests);
// ✅ STR listing + AI extraction
safeUse("/api/ps/str", require("./routes/psStr"));
safeUse("/api/ps/str/calendar", require("./routes/psStrCalendar"));
safeUse("/api/ps/ai/str", require("./routes/psAiStr"));
// ✅ STR AI (Gemini proxy + regex fallback)
app.use("/api/pc/ai/str", require("./routes/psAiStr"));


// PropertySanta STR listings (photos, calendar, admin insights, etc.)
// Frontend calls: /ps/str/* -> API_BASE (/api) + /ps/str/*
// app.use("/api/ps/str/calendar", require("./routes/psStrCalendar"));





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
safeUse('/api/jobs', auth, requireTenantAccess, require('./src/routes/jobs.route'));
safeUse('/api/offers', require('./src/routes/offers.route'));
safeUse('/api/config', require('./src/routes/config.route'));
safeUse(
  '/api/ceo',
  auth,
  requireTenantAccess,
  requireTenantRole(['owner', 'admin', 'ops']),
  require('./src/routes/ceo.route')
);
safeUse(
  '/api/customer/summary',
  auth,
  requireTenantAccess,
  require('./src/routes/customer/summary.route')
);
// safeUse('/api/customer/orders', require('./src/routes/customer/orders.route'));
safeUse(
  '/api/customer/orders',
  auth,
  requireTenantAccess,
  require('./src/routes/customer/orders.route')
);
safeUse(
  '/api/customer/properties',
  auth,
  requireTenantAccess,
  require('./src/routes/customer/properties.route')
);
safeUse(
  '/api/customer/summary',
  auth,
  requireTenantAccess,
  require('./src/routes/customer/summary.route')
);
safeUse(
  '/api/customer/tasks',
  auth,
  requireTenantAccess,
  require('./src/routes/customer/tasks.route')
);

safeUse('/api/customer/autopay', require('./src/routes/customer/autopay.route'));
// safeUse('/api/payments/paypal/webhook', require('./src/routes/payments/paypal.webhook.route'));
safeUse('/api/users/me', require('./src/routes/users.me.route'));
safeUse('/api/payroll', require('./src/routes/payroll.route'));
safeUse("/api/internal/receipts/google-legacy", internalLegacyGmailReceiptsRoutes); // legacy internal only
safeUse("/api/receipts/google", retailGmailReceiptsRoutes); // canonical retail tenant route
safeUse("/api/general-data/google", generalDataGmailRoutes);
safeUse("/api/business-intelligence/webhook", businessIntelligenceWebhookRoutes);
safeUse("/api/business-intelligence", auth, requireTenantAccess, businessIntelligenceRoutes);
safeUse("/api/receipts", auth, require("./routes/receipts.routes"));

/* -------------------- Debug helpers -------------------- */
app.get('/debug/properties', blockDebugInProduction, async (req, res) => {
  try {
    const Property = require('./models/Property');
    const properties = await Property.find({});
    res.json({ success: true, count: properties.length, properties });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

app.get('/__debug/wo-model', blockDebugInProduction, (req, res) => {
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
// const connectDB = async () => {
//   try {
//     await mongoose.connect(process.env.MONGODB_URI);
//     console.log('✅ MongoDB connected successfully');
//   } catch (error) {
//     console.error('❌ MongoDB connection error:', error);
//     // process.exit(1);
//     throw error;
//   }
//   await require('./src/models/Job').syncIndexes();

// };
const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI missing in environment variables (Vercel).");
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✅ MongoDB connected successfully");
  await require("./src/models/Job").syncIndexes();
};


/* -------------------- Seed (idempotent) -------------------- */
const initializeDatabase = async () => {
  try {
    console.log('🔄 Starting database initialization...');
    const User = require('./models/User');
    const Property = require('./models/Property');

    const cleanerEmail = process.env.SEED_CLEANER_EMAIL || "elite@example.com";
    const customerEmail = process.env.SEED_CUSTOMER_EMAIL || "customer@example.com";
    const adminEmail = process.env.ADMIN_EMAIL;

    const cleanerSeedPassword = process.env.CLEANER_SEED_PASSWORD;
    const customerSeedPassword = process.env.CUSTOMER_SEED_PASSWORD;
    const adminSeedPassword = process.env.ADMIN_SEED_PASSWORD;

    if (
      !adminEmail ||
      !cleanerSeedPassword ||
      !customerSeedPassword ||
      !adminSeedPassword
    ) {
      console.log("⏭️ Skipping sample user seed: seed env vars missing");
      return;
    }

    const hash = (pwd) => bcrypt.hash(pwd, 12);
    const [cleanerHash, customerHash, adminHash] = await Promise.all([
      hash(cleanerSeedPassword),
      hash(customerSeedPassword),
      hash(adminSeedPassword),
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
// const startServer = async () => {
//   await connectDB();

//   // --- WO model compile guard ---
//   try {
//     const mongoose = require('mongoose');
//     const canonicalPath = require('path').resolve(__dirname, './src/models/WarehouseOrder');

//     const existing = mongoose.models.WarehouseOrder;
//     if (existing) {
//       const t = existing.schema.path('orderId')?.instance;
//       if (t !== 'String') {
//         console.warn('⚠️ Recompiling WarehouseOrder with String orderId (was:', t, ')');
//         mongoose.deleteModel('WarehouseOrder');
//         delete require.cache[require.resolve(canonicalPath)];
//       }
//     }
//     require('./src/models/WarehouseOrder'); // force-load canonical
//     const check = mongoose.models.WarehouseOrder?.schema.path('orderId')?.instance;
//     console.log('✅ WarehouseOrder.orderId type:', check);
//   } catch (e) {
//     console.error('❌ WO model fix failed:', e);
//   }

//   // --- seed + routes mount ---
//   await initializeDatabase();
//   await mountESMRoutes(app);

//   // ✅ Explicit CJS mounts for messages (no ESM ambiguity)
//   safeUse('/api/customer/messages', require('./src/routes/customer/messages.route'));
//   safeUse('/api/admin/messages', require('./src/routes/admin/messages.route'));
//   console.log('✅ Mounted via safeUse: /api/customer/messages* and /api/admin/messages*');

//   // --- error handler MUST be after all mounts ---
//   app.use((err, req, res, next) => {
//     console.error('Unhandled error:', err);
//     res.status(500).json({ ok: false, error: err.message });
//   });

//   // --- create server + socket.io attach ---
//   const http = require('http');
//   const httpServer = http.createServer(app);
//   const { attachIO } = require('./src/server/socket');
//   attachIO(httpServer);

//   // --- bind port: prod = exact PORT; dev = findAvailablePort ---
//   const isProd = process.env.NODE_ENV === 'production';
//   const bindPort = isProd ? PORT : await findAvailablePort(PORT);

//   httpServer.listen(bindPort, () => {
//     console.log(`🚀 Server running on port ${bindPort}`);
//     console.log(`📱 API available at http://localhost:${bindPort}`);
//     console.log(`🔗 Health check: http://localhost:${bindPort}/health`);
//     if (!isProd) {
//       updateFrontendEnv(bindPort);
//       if (bindPort !== PORT) console.log(`⚠️ Port ${PORT} was in use, using ${bindPort}`);
//     }
//   });
// };

// startServer();



/* -------------------- Init (Vercel-safe) -------------------- */
let _initPromise = null;
let retailReceiptSchedulerStarted = false;

const initApp = async () => {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // DB connect once
    if (mongoose.connection.readyState !== 1) {
      await connectDB();
      await require("./src/models/Job").syncIndexes();
    }

    // Optional: Seed only if you explicitly enable it
    if (process.env.SEED_ON_START === "true") {
      await initializeDatabase();
    }

    // Mount the async-import routes
    // await mountESMRoutes(app);
    mountRoutes();
    const schedulerBootFlag = String(process.env.RETAIL_AUTO_SCHEDULER_BOOT || "false").trim();
    const schedulerEnabledFlag = String(process.env.RETAIL_AUTO_SCHEDULER_ENABLED || "false").trim();
    const schedulerRunOnStartFlag = String(process.env.RETAIL_AUTO_SCHEDULER_RUN_ON_START || "false").trim();
    const shouldBootRetailScheduler = schedulerBootFlag === "true";

    if (!retailReceiptSchedulerStarted && shouldBootRetailScheduler) {
      const schedulerStatus = startRetailReceiptScheduler();
      retailReceiptSchedulerStarted = true;
      console.log("[retail-scheduler]", {
        boot: schedulerBootFlag,
        enabled: schedulerEnabledFlag,
        runOnStart: schedulerRunOnStartFlag,
        status: schedulerStatus,
      });
    } else if (!retailReceiptSchedulerStarted) {
      console.log("[retail-scheduler] boot skipped", {
        boot: schedulerBootFlag,
        enabled: schedulerEnabledFlag,
        runOnStart: schedulerRunOnStartFlag,
      });
    }


    // customer messages (was after mount in your file)
    safeUse("/api/customer/messages", require("./src/routes/customer/messages.route"));

    safeUse("/api/admin/messages", require("./src/routes/admin/messages.route"));

    app.use((req, res) => {
      return res.status(404).json({
        ok: false,
        error: "not_found",
        message: "Route not found",
        requestId: req.requestId || null,
      });
    });

    // error handler should be LAST
    app.use((err, req, res, next) => {
      const status = Number(err.status || err.statusCode || 500);
      const expose = status >= 400 && status < 500;

      if (status >= 500) {
        console.error("🔥 SERVER ERROR:", {
          requestId: req.requestId || null,
          method: req.method,
          path: req.originalUrl,
          stack: err.stack || String(err),
        });
      }

      return res.status(status).json({
        ok: false,
        error: expose ? (err.code || "request_failed") : "internal_error",
        message: expose ? err.message : "Internal server error",
        requestId: req.requestId || null,
        ...(process.env.NODE_ENV !== "production" ? { stack: err.stack } : {}),
      });
    });

    return true;
  })();

  return _initPromise;
};

/* -------------------- Local server start (only outside Vercel) -------------------- */
const startServer = async () => {
  await initApp();

  const http = require("http");
  const { attachIO } = require("./src/server/socket");

  const PORT = await findAvailablePort(process.env.PORT || 5000);
  const httpServer = http.createServer(app);

  // ⚠️ Vercel pe socket.io mat chalao (local only)
  attachIO(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    updateFrontendEnv(PORT);
  });
};

// ✅ Important: Vercel pe auto-start nahi karna
if (!process.env.VERCEL) {
  startServer();
}

// ✅ Export for Vercel handler
// ✅ Vercel handler: ensure init happens, then let Express handle the request
const vercelHandler = async (req, res) => {
  await initApp();
  return app(req, res);
};

// (optional) keep access to app/initApp if you import elsewhere
vercelHandler.app = app;
vercelHandler.initApp = initApp;

module.exports = vercelHandler;

