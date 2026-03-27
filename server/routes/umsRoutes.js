const express = require('express');
const router  = express.Router();
const pool    = require('../db').pool;
const { requireAuth, requireRole } = require('../auth');

// ── GET all UMS checklists for a vessel ─────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const { vessel_id, from, to, limit = 30 } = req.query;
  if (!vessel_id) return res.status(400).json({ error: 'vessel_id required' });
  try {
    const params = [vessel_id];
    let q = `SELECT id, ref_number, checklist_date, is_locked, de_signed, ce_signed,
                    duty_engineer, chief_engineer, created_at, updated_at
             FROM ums_checklists WHERE vessel_id=$1`;
    if (from) { params.push(from); q += ` AND checklist_date >= $${params.length}::date`; }
    if (to)   { params.push(to);   q += ` AND checklist_date <= $${params.length}::date`; }
    q += ` ORDER BY checklist_date DESC LIMIT $${params.length+1}`;
    params.push(parseInt(limit));
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET single UMS checklist ─────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.*, v.name AS vessel_name,
              cb.display_name AS created_by_name,
              ds.display_name AS de_signer_name,
              cs.display_name AS ce_signer_name
       FROM ums_checklists u
       LEFT JOIN eom_vessels v ON v.id = u.vessel_id
       LEFT JOIN eom_users cb ON cb.id = u.created_by
       LEFT JOIN eom_users ds ON ds.id = u.de_signed_by
       LEFT JOIN eom_users cs ON cs.id = u.ce_signed_by
       WHERE u.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET by date for a vessel ─────────────────────────────────────────────────
router.get('/date/:vessel_id/:date', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.*, v.name AS vessel_name
       FROM ums_checklists u
       LEFT JOIN eom_vessels v ON v.id = u.vessel_id
       WHERE u.vessel_id=$1 AND u.checklist_date=$2::date`,
      [req.params.vessel_id, req.params.date]);
    res.json(rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CREATE or UPDATE checklist ───────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { vessel_id, checklist_date, items, remarks, duty_engineer } = req.body;
  if (!vessel_id || !checklist_date) return res.status(400).json({ error: 'vessel_id and checklist_date required' });
  try {
    // Check if one already exists for this date
    const existing = await pool.query(
      'SELECT id, is_locked FROM ums_checklists WHERE vessel_id=$1 AND checklist_date=$2::date',
      [vessel_id, checklist_date]);

    if (existing.rows.length) {
      const rec = existing.rows[0];
      // Only admin can edit locked checklists
      if (rec.is_locked && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Checklist is locked. Contact admin to make changes.' });
      }
      const { rows } = await pool.query(
        `UPDATE ums_checklists SET items=$1, remarks=$2, duty_engineer=$3, updated_at=NOW()
         WHERE id=$4 RETURNING *`,
        [JSON.stringify(items || {}), remarks || '', duty_engineer || '', rec.id]);
      return res.json(rows[0]);
    }

    // Create new
    const { rows } = await pool.query(
      `INSERT INTO ums_checklists (vessel_id, checklist_date, items, remarks, duty_engineer, created_by)
       VALUES ($1, $2::date, $3, $4, $5, $6) RETURNING *`,
      [vessel_id, checklist_date, JSON.stringify(items || {}), remarks || '', duty_engineer || '', req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SIGN — duty engineer signs ───────────────────────────────────────────────
router.post('/:id/sign-de', requireAuth, async (req, res) => {
  try {
    const { rows: rec } = await pool.query('SELECT * FROM ums_checklists WHERE id=$1', [req.params.id]);
    if (!rec.length) return res.status(404).json({ error: 'Not found' });
    if (rec[0].is_locked) return res.status(403).json({ error: 'Already locked.' });

    const { rows } = await pool.query(
      `UPDATE ums_checklists
       SET de_signed=true, de_signed_at=NOW(), de_signed_by=$1,
           duty_engineer=COALESCE(NULLIF($2,''), duty_engineer), updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [req.user.id, req.body.duty_engineer || '', req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SIGN — chief engineer signs and LOCKS ────────────────────────────────────
router.post('/:id/sign-ce', requireAuth, async (req, res) => {
  try {
    const { rows: rec } = await pool.query('SELECT * FROM ums_checklists WHERE id=$1', [req.params.id]);
    if (!rec.length) return res.status(404).json({ error: 'Not found' });
    if (rec[0].is_locked && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Already locked.' });
    }
    if (!rec[0].de_signed) return res.status(400).json({ error: 'Duty engineer must sign first.' });

    const { rows } = await pool.query(
      `UPDATE ums_checklists
       SET ce_signed=true, ce_signed_at=NOW(), ce_signed_by=$1,
           chief_engineer=COALESCE(NULLIF($2,''), chief_engineer),
           is_locked=true, updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [req.user.id, req.body.chief_engineer || '', req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN UNLOCK ─────────────────────────────────────────────────────────────
router.post('/:id/unlock', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE ums_checklists SET is_locked=false, ce_signed=false, ce_signed_at=NULL,
       de_signed=false, de_signed_at=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
