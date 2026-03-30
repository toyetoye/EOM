const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');

// GET /api/vessels
// - vessel/engineer/smt roles: only vessels assigned to them
// - all others: all active vessels
router.get('/', requireAuth, async (req, res) => {
  try {
    let rows;
    if (['vessel','engineer','smt'].includes(req.user.role)) {
      const result = await pool.query(
        `SELECT v.* FROM eom_vessels v
         JOIN eom_user_vessels uv ON uv.vessel_id = v.id
         WHERE uv.user_id=$1 AND v.active=true
         ORDER BY v.name`, [req.user.id]
      );
      rows = result.rows;
    } else {
      const result = await pool.query(
        'SELECT * FROM eom_vessels WHERE active=true ORDER BY name'
      );
      rows = result.rows;
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
