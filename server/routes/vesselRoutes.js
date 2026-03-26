const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');

// GET /api/vessels
router.get('/', requireAuth, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'vessel' || req.user.role === 'engineer') {
      const result = await pool.query(
        `SELECT v.* FROM eom_vessels v
         JOIN eom_user_vessels uv ON uv.vessel_id = v.id
         WHERE uv.user_id=$1 AND v.active=true`, [req.user.id]
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

// POST /api/vessels — admin only
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, imo, type } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO eom_vessels (name,imo,type) VALUES ($1,$2,$3) RETURNING *',
      [name, imo || null, type || 'LPG']
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vessels/:id/duty-engineers
// Returns all active users assigned to this vessel (for D/E dropdown)
router.get('/:id/duty-engineers', requireAuth, async (req, res) => {
  try {
    // Get engineers assigned to this specific vessel
    const { rows } = await pool.query(`
      SELECT u.id,
             u.username,
             COALESCE(u.display_name, u.username) AS display_name,
             u.role
      FROM eom_users u
      JOIN eom_user_vessels uv ON uv.user_id = u.id
      WHERE uv.vessel_id = $1
        AND u.active = true
        AND u.role != 'vessel'
      ORDER BY u.display_name, u.username
    `, [req.params.id]);

    // If no individual crew assigned yet, fall back to all active non-admin users
    if (!rows.length) {
      const fallback = await pool.query(`
        SELECT id, username,
               COALESCE(display_name, username) AS display_name,
               role
        FROM eom_users
        WHERE active = true
          AND role NOT IN ('vessel')
        ORDER BY display_name, username
        LIMIT 50
      `);
      return res.json(fallback.rows);
    }

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
