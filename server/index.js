require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB, addUMSTables, pool } = require('./db');

const app = express();

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    const allowed = [
      'https://eom.forcap.io',
      'https://forcap.io',
      // Railway preview URLs
      /https:\/\/.*\.up\.railway\.app$/,
      // Localhost for dev
      /^http:\/\/localhost/,
    ];
    const ok = allowed.some(p =>
      typeof p === 'string' ? p === origin : p.test(origin)
    );
    callback(ok ? null : new Error('CORS blocked: ' + origin), ok);
  },
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/authRoutes'));
app.use('/api/vessels', require('./routes/vesselRoutes'));
app.use('/api/watches', require('./routes/watchRoutes'));
app.use('/api/admin',   require('./routes/adminRoutes'));
app.use('/api/defects',  require('./routes/defectRoutes'));
app.use('/api/ums',      require('./routes/umsRoutes'));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── SERVE FRONTEND ────────────────────────────────────────────────────────────
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC));
// Named HTML pages served directly; everything else → index.html
app.get('*', (req, res) => {
  const fs = require('fs');
  // If the request looks like a specific file that exists, serve it
  const filePath = path.join(PUBLIC, req.path);
  if (req.path.endsWith('.html') && fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  res.sendFile(path.join(PUBLIC, 'index.html'));
});


// ── ONE-TIME VESSEL MIGRATION ENDPOINT ─────────────────────────────────────
app.post('/api/migrate/vessels', async (req, res) => {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    const u = jwt.verify(token, process.env.JWT_SECRET || 'eom-dev-secret');
    if (u.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  } catch(e) { return res.status(401).json({ error: 'bad token' }); }
  const client = await pool.connect();
  const results = [];
  try {
    await client.query('ALTER TABLE eom_vessels ADD COLUMN IF NOT EXISTS propulsion_type VARCHAR(50)');
    await client.query('ALTER TABLE eom_vessels ADD COLUMN IF NOT EXISTS vessel_class VARCHAR(50)');
    const vessels = [["Aktoras", "9958286", "LNG", "2-STROKE", "AKTORAS"], ["Axios II", "9943853", "LNG", "2-STROKE", "AKTORAS"], ["LNG Adamawa", "9262211", "LNG", "STEAM", "RIVERS"], ["LNG Akwa-Ibom", "9262209", "LNG", "STEAM", "RIVERS"], ["LNG River Niger", "9262235", "LNG", "STEAM", "RIVERS"], ["LNG Cross-River", "9262223", "LNG", "STEAM", "RIVERS"], ["LNG Sokoto", "9216303", "LNG", "STEAM", "RIVERS PLUS"], ["LNG Finima II", "9690145", "LNG", "DFDE", "SHI"], ["LNG Portharcourt II", "9690157", "LNG", "DFDE", "SHI"], ["LNG Bonny II", "9692002", "LNG", "DFDE", "HHI"], ["LNG Lagos II", "9692014", "LNG", "DFDE", "HHI"], ["Alfred Temile", "9859882", "LPG", "2-STROKE", "AT"], ["Alfred Temile 10", "9937127", "LPG", "2-STROKE", "AT10"]];
    for (const [name, imo, type, propulsion_type, vessel_class] of vessels) {
      const r = await client.query(
        `INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,
           propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class,active=true
         RETURNING id,name,imo,type,propulsion_type,vessel_class`,
        [name,imo,type,propulsion_type,vessel_class]
      );
      results.push(r.rows[0]);
    }
  } finally { client.release(); }
  res.json({ migrated: results.length, vessels: results });
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;

initDB()
  .then(() => addUMSTables())
  .then(() => {
    app.listen(PORT, () => console.log(`EOM backend on :${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialise DB:', err.message);
    process.exit(1);
  });

// ── AI DIAGNOSTIC PROXY ───────────────────────────────────────────────────────
// POST /api/ai/diagnose — proxies to Anthropic so we avoid browser CORS
app.post('/api/ai/diagnose', require('./routes/authRoutes').requireAuthMiddleware || ((req,res,next) => next()), async (req, res) => {
  // Simple auth check
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  let decoded;
  try {
    decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'eom-dev-secret');
  } catch { return res.status(401).json({ error: 'Invalid token' }); }

  // AI chat restricted to superintendent, manager, admin only
  const allowedRoles = ['admin', 'superintendent', 'manager'];
  if (!allowedRoles.includes(decoded.role)) {
    return res.status(403).json({ error: 'AI chat is restricted to superintendents and managers.' });
  }

  const { system, prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const https = require('https');
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: system || 'You are an experienced marine chief engineer. Respond only with valid JSON.',
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.json(parsed);
        } catch(e) {
          res.status(500).json({ error: 'Invalid response from AI', raw: data.slice(0, 200) });
        }
      });
    });
    proxyReq.on('error', e => res.status(500).json({ error: e.message }));
    proxyReq.write(body);
    proxyReq.end();
  } catch(e) { res.status(500).json({ error: e.message }); }
});
