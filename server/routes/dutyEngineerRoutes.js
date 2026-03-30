const express = require('express');
const router  = express.Router();
const pool    = require('../db').pool;
const { requireAuth, requireRole } = require('../auth');

const canManage = (req, res, next) => {
  // Admin and superintendent can manage any vessel
  // SMT can only manage their assigned vessel
  if (['admin','superintendent'].includes(req.user.role)) return next();
  if (req.user.role === 'smt') {
    // Check vessel is assigned to this user — resolved in each handler
    req._smtCheck = true;
    return next();
  }
  return res.status(403).json({ error: 'Permission denied' });
};

// Helper: verify SMT user is assigned to this vessel
async function checkSmtVessel(userId, vesselId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM eom_user_vessels WHERE user_id=$1 AND vessel_id=$2',
    [userId, vesselId]
  );
  return rows.length > 0;
}

// GET /api/vessels/:vessel_id/duty-engineers
router.get('/:vessel_id/duty-engineers', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vessel_duty_engineers
       WHERE vessel_id=$1 AND active=true
       ORDER BY display_order, id`,
      [req.params.vessel_id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vessels/:vessel_id/duty-engineers/all  (includes inactive, for admin)
router.get('/:vessel_id/duty-engineers/all', requireAuth, canManage, async (req, res) => {
  try {
    if (req._smtCheck && !await checkSmtVessel(req.user.id, req.params.vessel_id))
      return res.status(403).json({ error: 'Not your vessel' });
    const { rows } = await pool.query(
      'SELECT * FROM vessel_duty_engineers WHERE vessel_id=$1 ORDER BY display_order,id',
      [req.params.vessel_id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vessels/:vessel_id/duty-engineers
router.post('/:vessel_id/duty-engineers', requireAuth, canManage, async (req, res) => {
  const { rank, name, display_order } = req.body;
  if (!rank || !name) return res.status(400).json({ error: 'rank and name required' });
  if (req._smtCheck && !await checkSmtVessel(req.user.id, req.params.vessel_id))
    return res.status(403).json({ error: 'Not your vessel' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO vessel_duty_engineers (vessel_id,rank,name,display_order,active)
       VALUES ($1,$2,$3,$4,true) RETURNING *`,
      [req.params.vessel_id, rank.trim(), name.trim(), display_order||0]
    );
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/vessels/:vessel_id/duty-engineers/:id
router.put('/:vessel_id/duty-engineers/:id', requireAuth, canManage, async (req, res) => {
  const { rank, name, display_order, active } = req.body;
  if (req._smtCheck && !await checkSmtVessel(req.user.id, req.params.vessel_id))
    return res.status(403).json({ error: 'Not your vessel' });
  try {
    const { rows } = await pool.query(
      `UPDATE vessel_duty_engineers
       SET rank=$1, name=$2, display_order=$3, active=$4
       WHERE id=$5 AND vessel_id=$6 RETURNING *`,
      [rank, name, display_order||0, active!==false, req.params.id, req.params.vessel_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/vessels/:vessel_id/duty-engineers/:id  (soft delete)
router.delete('/:vessel_id/duty-engineers/:id', requireAuth, canManage, async (req, res) => {
  if (req._smtCheck && !await checkSmtVessel(req.user.id, req.params.vessel_id))
    return res.status(403).json({ error: 'Not your vessel' });
  try {
    await pool.query(
      'UPDATE vessel_duty_engineers SET active=false WHERE id=$1 AND vessel_id=$2',
      [req.params.id, req.params.vessel_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
