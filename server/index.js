require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

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

// ── BOOT ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;

initDB()
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
