const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const guard = [requireAuth, requireRole('admin', 'superintendent')];
const adminOnly = [requireAuth, requireRole('admin')];

// ── USERS ──────────────────────────────────────────────────────────────────────
router.get('/users', ...guard, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.role, u.active, u.display_name, u.email,
             COALESCE(json_agg(
               json_build_object('id',v.id,'name',v.name)
             ) FILTER (WHERE v.id IS NOT NULL), '[]') AS vessels
      FROM eom_users u
      LEFT JOIN eom_user_vessels uv ON uv.user_id = u.id
      LEFT JOIN eom_vessels v ON v.id = uv.vessel_id
      GROUP BY u.id
      ORDER BY CASE u.role WHEN 'admin' THEN 1 WHEN 'superintendent' THEN 2 ELSE 3 END, u.display_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/users', ...guard, async (req, res) => {
  const { username, password, role, display_name, email, vessel_ids } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO eom_users (username,password,role,display_name,email)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,username,role,display_name,email`,
      [username.toLowerCase().trim(), hashed, role||'engineer',
       display_name||username, email||null]
    );
    const user = rows[0];
    for (const vid of (vessel_ids||[])) {
      await pool.query(
        'INSERT INTO eom_user_vessels (user_id,vessel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [user.id, vid]
      );
    }
    res.json(user);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id', ...guard, async (req, res) => {
  const { role, active, password, display_name, email, vessel_ids } = req.body;
  try {
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      await pool.query('UPDATE eom_users SET password=$1 WHERE id=$2', [hashed, req.params.id]);
    }
    await pool.query(
      'UPDATE eom_users SET role=$1, active=$2, display_name=$3, email=$4 WHERE id=$5',
      [role, active !== false, display_name||null, email||null, req.params.id]
    );
    if (vessel_ids !== undefined) {
      await pool.query('DELETE FROM eom_user_vessels WHERE user_id=$1', [req.params.id]);
      for (const vid of (vessel_ids||[])) {
        await pool.query(
          'INSERT INTO eom_user_vessels (user_id,vessel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [req.params.id, vid]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/users/:id', ...guard, async (req, res) => {
  try {
    await pool.query('UPDATE eom_users SET active=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VESSELS ───────────────────────────────────────────────────────────────────
router.get('/vessels', ...guard, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.*, COUNT(uv.user_id)::int AS crew_count
      FROM eom_vessels v
      LEFT JOIN eom_user_vessels uv ON uv.vessel_id = v.id
      GROUP BY v.id ORDER BY v.name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/vessels', ...adminOnly, async (req, res) => {
  const { name, imo, type, propulsion_type, vessel_class } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ($1,$2,$3,$4,$5,true) RETURNING *',
      [name.trim(), imo||null, type||'LPG', propulsion_type||null, vessel_class||null]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'IMO already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/vessels/:id', ...adminOnly, async (req, res) => {
  const { name, imo, type, active } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE eom_vessels SET name=$1,imo=$2,type=$3,propulsion_type=$4,vessel_class=$5,active=$6 WHERE id=$7 RETURNING *',
      [name, imo||null, type||'LPG', propulsion_type||null, vessel_class||null, active !== false, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/vessels/:id', ...adminOnly, async (req, res) => {
  try {
    // Soft delete — deactivate rather than destroy data
    await pool.query('UPDATE eom_vessels SET active=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
