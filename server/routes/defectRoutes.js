const express = require('express');
const router  = express.Router();
const pool    = require('../db').pool;
const { requireAuth, requireRole } = require('../auth');

// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(vesselId, entityType, entityId, action, changedBy, oldVal, newVal, req) {
  try {
    await pool.query(`
      INSERT INTO eom_audit_log
        (vessel_id,entity_type,entity_id,action,changed_by,old_value,new_value,ip_address,user_agent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [vesselId, entityType, entityId, action, changedBy,
        oldVal ? JSON.stringify(oldVal) : null,
        newVal ? JSON.stringify(newVal) : null,
        req?.ip || null,
        req?.headers?.['user-agent'] || null]);
  } catch(e) { console.error('audit log error:', e.message); }
}

// ── LIST defects ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const { vessel_id, status, limit = 100 } = req.query;
  if (!vessel_id) return res.status(400).json({ error: 'vessel_id required' });
  try {
    const conditions = ['d.vessel_id = $1'];
    const params = [vessel_id];
    if (status) { conditions.push(`d.status = $${params.length+1}`); params.push(status); }
    const { rows } = await pool.query(`
      SELECT d.*,
        COUNT(c.id)::int AS comment_count
      FROM eom_defects d
      LEFT JOIN eom_defect_comments c ON c.defect_id = d.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY d.id
      ORDER BY
        CASE d.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        d.date_reported DESC
      LIMIT $${params.length+1}
    `, [...params, limit]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET single defect with comments ──────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM eom_defects WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: comments } = await pool.query(
      'SELECT * FROM eom_defect_comments WHERE defect_id=$1 ORDER BY created_at',
      [req.params.id]
    );
    res.json({ ...rows[0], comments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CREATE defect ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { vessel_id, reported_by, location, equipment, description,
          suggested_fix, priority, reported_to, date_reported_to,
          expected_closeout, sire_relevant } = req.body;
  if (!vessel_id || !reported_by || !description)
    return res.status(400).json({ error: 'vessel_id, reported_by, description required' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO eom_defects
        (vessel_id,reported_by,location,equipment,description,suggested_fix,
         priority,reported_to,date_reported_to,expected_closeout,sire_relevant)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [vessel_id, reported_by, location||null, equipment||null, description,
        suggested_fix||null, priority||'normal', reported_to||null,
        date_reported_to||null, expected_closeout||null, sire_relevant||false]);
    const defect = rows[0];
    // Set ref number
    await pool.query(`UPDATE eom_defects SET ref_number='DEF-'||LPAD(id::TEXT,4,'0') WHERE id=$1 AND ref_number IS NULL`, [defect.id]);
    await audit(vessel_id, 'defect', defect.id, 'created', reported_by, null, defect, req);
    res.json({ ...defect, ref_number: defect.ref_number || 'DEF-' + String(defect.id).padStart(4,'0') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── UPDATE defect ─────────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: old } = await pool.query('SELECT * FROM eom_defects WHERE id=$1', [req.params.id]);
    if (!old.length) return res.status(404).json({ error: 'Not found' });
    const o = old[0];
    const fields = ['status','priority','reported_to','date_reported_to',
                    'expected_closeout','date_closed','closed_by','suggested_fix','sire_relevant'];
    const updates = [];
    const params = [req.params.id];
    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f}=$${params.length+1}`);
        params.push(req.body[f]);
      }
    });
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    updates.push(`updated_at=NOW()`);
    const { rows } = await pool.query(
      `UPDATE eom_defects SET ${updates.join(',')} WHERE id=$1 RETURNING *`, params
    );
    await audit(o.vessel_id, 'defect', o.id, 'updated', req.user?.username||'unknown', o, rows[0], req);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADD comment ───────────────────────────────────────────────────────────────
router.post('/:id/comments', requireAuth, async (req, res) => {
  const { author, role, comment } = req.body;
  if (!author || !comment) return res.status(400).json({ error: 'author and comment required' });
  try {
    const { rows } = await pool.query(`
      INSERT INTO eom_defect_comments (defect_id,author,role,comment)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [req.params.id, author, role||'vessel', comment]);
    // Update defect updated_at
    await pool.query('UPDATE eom_defects SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AUDIT TRAIL for a defect ──────────────────────────────────────────────────
router.get('/:id/audit', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM eom_audit_log
      WHERE entity_type='defect' AND entity_id=$1
      ORDER BY changed_at DESC
    `, [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STATS summary ─────────────────────────────────────────────────────────────
router.get('/stats/summary', requireAuth, async (req, res) => {
  const { vessel_id } = req.query;
  if (!vessel_id) return res.status(400).json({ error: 'vessel_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='open')         AS open,
        COUNT(*) FILTER (WHERE status='in_progress')  AS in_progress,
        COUNT(*) FILTER (WHERE status='closed')       AS closed,
        COUNT(*) FILTER (WHERE priority='critical' AND status!='closed') AS critical,
        COUNT(*) FILTER (WHERE priority='high' AND status!='closed')     AS high,
        COUNT(*) FILTER (WHERE sire_relevant=true AND status!='closed')  AS sire_open,
        COUNT(*) FILTER (WHERE expected_closeout < CURRENT_DATE AND status NOT IN ('closed','cancelled')) AS overdue
      FROM eom_defects WHERE vessel_id=$1
    `, [vessel_id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
