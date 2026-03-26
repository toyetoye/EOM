const router = require('express').Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');

// Watch number → label map
const WATCH_LABELS = {
  1: '00:00–04:00', 2: '04:00–08:00', 3: '08:00–12:00',
  4: '12:00–16:00', 5: '16:00–20:00', 6: '20:00–24:00'
};

// ── GET list of watches for a vessel ─────────────────────────────────────────
// GET /api/watches?vessel_id=&date=YYYY-MM-DD
router.get('/', requireAuth, async (req, res) => {
  const { vessel_id, date, month } = req.query;
  if (!vessel_id) return res.status(400).json({ error: 'vessel_id required' });

  // Vessel users can only see their own vessel
  if (req.user.role === 'vessel' && Number(req.user.vessel_id) !== Number(vessel_id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    let query, params;
    if (date) {
      query = `
        SELECT w.*, v.name as vessel_name
        FROM eom_watches w JOIN eom_vessels v ON v.id=w.vessel_id
        WHERE w.vessel_id=$1 AND w.watch_date=$2
        ORDER BY w.watch_number`;
      params = [vessel_id, date];
    } else if (month) {
      // month = YYYY-MM
      query = `
        SELECT w.*, v.name as vessel_name,
          (SELECT COUNT(*) FROM eom_readings r WHERE r.watch_id=w.id) as reading_count
        FROM eom_watches w JOIN eom_vessels v ON v.id=w.vessel_id
        WHERE w.vessel_id=$1 AND to_char(w.watch_date,'YYYY-MM')=$2
        ORDER BY w.watch_date DESC, w.watch_number`;
      params = [vessel_id, month];
    } else {
      // Last 7 days
      query = `
        SELECT w.*, v.name as vessel_name,
          (SELECT COUNT(*) FROM eom_readings r WHERE r.watch_id=w.id) as reading_count
        FROM eom_watches w JOIN eom_vessels v ON v.id=w.vessel_id
        WHERE w.vessel_id=$1 AND w.watch_date >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY w.watch_date DESC, w.watch_number`;
      params = [vessel_id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET or CREATE the current watch ──────────────────────────────────────────
// GET /api/watches/current?vessel_id=&date=&watch_number=
router.get('/current', requireAuth, async (req, res) => {
  const { vessel_id, date, watch_number } = req.query;
  if (!vessel_id || !date || !watch_number) {
    return res.status(400).json({ error: 'vessel_id, date, watch_number required' });
  }
  try {
    // Upsert the watch header (draft)
    const { rows } = await pool.query(`
      INSERT INTO eom_watches (vessel_id, watch_date, watch_number, status)
      VALUES ($1,$2,$3,'draft')
      ON CONFLICT (vessel_id, watch_date, watch_number) DO UPDATE
        SET vessel_id=EXCLUDED.vessel_id
      RETURNING *
    `, [vessel_id, date, watch_number]);
    const watch = rows[0];

    // Fetch all readings for this watch
    const readings = await pool.query(
      'SELECT * FROM eom_readings WHERE watch_id=$1', [watch.id]
    );
    // Fetch running hours
    const runHours = await pool.query(
      'SELECT * FROM eom_running_hours WHERE watch_id=$1', [watch.id]
    );
    // Fetch remarks
    const remarks = await pool.query(
      'SELECT * FROM eom_remarks WHERE watch_id=$1 ORDER BY created_at', [watch.id]
    );

    res.json({
      watch,
      readings: readings.rows,
      running_hours: runHours.rows,
      remarks: remarks.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET previous watch (for comparison column) ────────────────────────────────
// GET /api/watches/previous?vessel_id=&date=&watch_number=
router.get('/previous', requireAuth, async (req, res) => {
  const { vessel_id, date, watch_number } = req.query;
  try {
    // Find the immediately preceding watch (same vessel, submitted)
    const { rows } = await pool.query(`
      SELECT w.* FROM eom_watches w
      WHERE w.vessel_id=$1
        AND (w.watch_date < $2 OR (w.watch_date=$2 AND w.watch_number < $3))
        AND w.status IN ('submitted','locked')
      ORDER BY w.watch_date DESC, w.watch_number DESC
      LIMIT 1
    `, [vessel_id, date, watch_number]);

    if (!rows.length) return res.json({ watch: null, readings: [] });

    const prev = rows[0];
    const readings = await pool.query(
      'SELECT * FROM eom_readings WHERE watch_id=$1', [prev.id]
    );
    const runHours = await pool.query(
      'SELECT * FROM eom_running_hours WHERE watch_id=$1', [prev.id]
    );

    res.json({ watch: prev, readings: readings.rows, running_hours: runHours.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SAVE readings (autosave on blur) ─────────────────────────────────────────
// POST /api/watches/:id/readings
// Body: { readings: [{ location_path, section, equipment, parameter, unit_label, value, value_text, is_alarm, is_warning }] }
router.post('/:id/readings', requireAuth, async (req, res) => {
  const watchId = req.params.id;
  const { readings } = req.body;
  if (!Array.isArray(readings)) return res.status(400).json({ error: 'readings must be an array' });

  // Check watch exists and is not locked
  try {
    const { rows } = await pool.query('SELECT * FROM eom_watches WHERE id=$1', [watchId]);
    if (!rows.length) return res.status(404).json({ error: 'Watch not found' });
    if (rows[0].status === 'locked') return res.status(403).json({ error: 'Watch is locked' });

    // Upsert each reading by (watch_id, location_path, parameter)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of readings) {
        await client.query(`
          INSERT INTO eom_readings
            (watch_id, location_path, section, equipment, parameter, unit_label, value, value_text, is_alarm, is_warning)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT DO NOTHING
        `, [
          watchId,
          r.location_path || null,
          r.section || null,
          r.equipment || null,
          r.parameter,
          r.unit_label || null,
          r.value != null ? r.value : null,
          r.value_text || null,
          r.is_alarm || false,
          r.is_warning || false
        ]);
        // Update by (watch_id, location_path, parameter) using a separate UPDATE for existing
        await client.query(`
          UPDATE eom_readings SET
            section=$3, equipment=$4, unit_label=$5, value=$6,
            value_text=$7, is_alarm=$8, is_warning=$9
          WHERE watch_id=$1 AND location_path=$2 AND parameter=$10
        `, [
          watchId,
          r.location_path || null,
          r.section || null,
          r.equipment || null,
          r.unit_label || null,
          r.value != null ? r.value : null,
          r.value_text || null,
          r.is_alarm || false,
          r.is_warning || false,
          r.parameter
        ]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, saved: readings.length });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SAVE running hours ────────────────────────────────────────────────────────
// POST /api/watches/:id/running-hours
router.post('/:id/running-hours', requireAuth, async (req, res) => {
  const watchId = req.params.id;
  const { items } = req.body; // [{ equipment, hours, minutes }]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items required' });
  try {
    const { rows } = await pool.query('SELECT status FROM eom_watches WHERE id=$1', [watchId]);
    if (!rows.length) return res.status(404).json({ error: 'Watch not found' });
    if (rows[0].status === 'locked') return res.status(403).json({ error: 'Watch is locked' });

    await pool.query('DELETE FROM eom_running_hours WHERE watch_id=$1', [watchId]);
    for (const item of items) {
      await pool.query(
        'INSERT INTO eom_running_hours (watch_id, equipment, hours, minutes) VALUES ($1,$2,$3,$4)',
        [watchId, item.equipment, item.hours || 0, item.minutes || 0]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SAVE remarks ──────────────────────────────────────────────────────────────
// POST /api/watches/:id/remarks
router.post('/:id/remarks', requireAuth, async (req, res) => {
  const watchId = req.params.id;
  const { remarks } = req.body; // [{ section, equipment, remark }]
  try {
    const { rows } = await pool.query('SELECT status FROM eom_watches WHERE id=$1', [watchId]);
    if (!rows.length) return res.status(404).json({ error: 'Watch not found' });
    if (rows[0].status === 'locked') return res.status(403).json({ error: 'Watch is locked' });

    await pool.query('DELETE FROM eom_remarks WHERE watch_id=$1', [watchId]);
    for (const r of (remarks || [])) {
      if (r.remark?.trim()) {
        await pool.query(
          'INSERT INTO eom_remarks (watch_id, section, equipment, remark) VALUES ($1,$2,$3,$4)',
          [watchId, r.section || null, r.equipment || null, r.remark.trim()]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SUBMIT watch (lock for vessel, mark submitted) ────────────────────────────
// POST /api/watches/:id/submit
router.post('/:id/submit', requireAuth, async (req, res) => {
  const { duty_engineer } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM eom_watches WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Watch not found' });
    if (rows[0].status === 'locked') return res.status(400).json({ error: 'Already locked' });

    await pool.query(`
      UPDATE eom_watches
      SET status='submitted', submitted_by=$1, submitted_at=NOW(), duty_engineer=$2
      WHERE id=$3
    `, [req.user.username, duty_engineer || req.user.username, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LOCK watch (super/admin only — prevents further amendment) ────────────────
// POST /api/watches/:id/lock
router.post('/:id/lock', requireAuth, requireRole('admin', 'superintendent'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE eom_watches SET status='locked' WHERE id=$1`, [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── UNLOCK watch (super/admin — with reason) ──────────────────────────────────
// POST /api/watches/:id/unlock
router.post('/:id/unlock', requireAuth, requireRole('admin', 'superintendent'), async (req, res) => {
  const { reason } = req.body;
  try {
    await pool.query(
      `UPDATE eom_watches SET status='draft' WHERE id=$1`, [req.params.id]
    );
    await pool.query(
      `INSERT INTO eom_amendments (watch_id, amended_by, reason) VALUES ($1,$2,$3)`,
      [req.params.id, req.user.username, reason || 'Unlocked for amendment']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FLEET OVERVIEW (super/admin dashboard) ────────────────────────────────────
// GET /api/watches/fleet-overview
router.get('/fleet-overview', requireAuth, requireRole('admin', 'superintendent'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        v.id, v.name, v.imo, v.type,
        (SELECT COUNT(*) FROM eom_watches w WHERE w.vessel_id=v.id AND w.watch_date=CURRENT_DATE) as watches_today,
        (SELECT MAX(w.watch_date) FROM eom_watches w WHERE w.vessel_id=v.id AND w.status IN ('submitted','locked')) as last_submission,
        (SELECT COUNT(*) FROM eom_readings r
           JOIN eom_watches w ON w.id=r.watch_id
           WHERE w.vessel_id=v.id AND r.is_alarm=true
             AND w.watch_date >= CURRENT_DATE - INTERVAL '24 hours') as alarms_24h
      FROM eom_vessels v WHERE v.active=true
      ORDER BY v.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ── INVENTORY HISTORY ─────────────────────────────────────────────────────────
// GET /api/watches/inventory?vessel_id=X&prefix=loi_   (or ch_, gas_)
// Returns all monthly ROB readings grouped by product × month
router.get('/inventory', requireAuth, async (req, res) => {
  const { vessel_id, prefix } = req.query;
  if (!vessel_id) return res.status(400).json({ error: 'vessel_id required' });

  try {
    const prefixes = prefix
      ? prefix.split(',').map(p => p.trim())
      : ['loi_', 'ch_', 'gas_'];

    const conditions = prefixes.map((_, i) => `r.location_path LIKE $${i + 2}`).join(' OR ');
    const params = [vessel_id, ...prefixes.map(p => p + '%')];

    const { rows } = await pool.query(`
      SELECT
        w.watch_date::date            AS month,
        r.location_path               AS fid,
        r.parameter                   AS product,
        r.unit_label                  AS unit,
        r.section,
        r.equipment,
        r.value                       AS rob
      FROM eom_readings r
      JOIN eom_watches w ON w.id = r.watch_id
      WHERE w.vessel_id = $1
        AND (${conditions})
        AND r.value IS NOT NULL
      ORDER BY w.watch_date, r.location_path
    `, params);

    // Group: { fid → { product, unit, section, months: { YYYY-MM → rob } } }
    const products = {};
    rows.forEach(r => {
      const ym = r.month.toISOString().slice(0, 7);
      if (!products[r.fid]) {
        products[r.fid] = {
          fid: r.fid, product: r.product,
          unit: r.unit, section: r.section,
          equipment: r.equipment, months: {}
        };
      }
      products[r.fid].months[ym] = parseFloat(r.rob);
    });

    // Build sorted month list
    const allMonths = [...new Set(rows.map(r => r.month.toISOString().slice(0, 7)))].sort();

    res.json({ products: Object.values(products), months: allMonths });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CYCLONE FILTER COUNTER ────────────────────────────────────────────────────
// GET  /api/watches/cyclone?vessel_id=X  → current hours since last reset per DG
router.get('/cyclone', requireAuth, async (req, res) => {
  const { vessel_id } = req.query;
  if (!vessel_id) return res.status(400).json({ error: 'vessel_id required' });
  try {
    // Get latest reset per DG
    const { rows: resets } = await pool.query(`
      SELECT DISTINCT ON (dg_number)
        dg_number, reset_at, reset_by, hours_at_reset, notes
      FROM eom_cyclone_resets
      WHERE vessel_id = $1
      ORDER BY dg_number, reset_at DESC
    `, [vessel_id]);

    // Get latest running hours per DG from eom_readings
    const DG_FIDS = { 1: 'rh_ae1', 2: 'rh_ae2', 3: 'rh_ae3' };
    const result = {};
    for (const dg of [1, 2, 3]) {
      const reset = resets.find(r => r.dg_number === dg);
      const { rows: hrs } = await pool.query(`
        SELECT r.value, w.watch_date
        FROM eom_readings r
        JOIN eom_watches w ON w.id = r.watch_id
        WHERE w.vessel_id = $1
          AND r.location_path = $2
          AND r.value IS NOT NULL
        ORDER BY w.watch_date DESC
        LIMIT 1
      `, [vessel_id, DG_FIDS[dg]]);

      const currentHours = hrs[0] ? parseFloat(hrs[0].value) : null;
      const hoursAtReset = reset ? parseFloat(reset.hours_at_reset) : null;
      const hoursSinceChange = (currentHours !== null && hoursAtReset !== null)
        ? Math.max(0, currentHours - hoursAtReset) : null;

      result[dg] = {
        dg_number: dg,
        last_reset: reset ? reset.reset_at : null,
        reset_by: reset ? reset.reset_by : null,
        hours_at_reset: hoursAtReset,
        current_hours: currentHours,
        hours_since_change: hoursSinceChange,
        alert: hoursSinceChange !== null && hoursSinceChange >= 120,
        warning: hoursSinceChange !== null && hoursSinceChange >= 100 && hoursSinceChange < 120,
      };
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/watches/cyclone/reset  → record a filter change
router.post('/cyclone/reset', requireAuth, async (req, res) => {
  const { vessel_id, dg_number, reset_by, hours_at_reset, notes } = req.body;
  if (!vessel_id || !dg_number) return res.status(400).json({ error: 'vessel_id and dg_number required' });
  try {
    await pool.query(`
      INSERT INTO eom_cyclone_resets (vessel_id, dg_number, reset_by, hours_at_reset, notes)
      VALUES ($1, $2, $3, $4, $5)
    `, [vessel_id, dg_number, reset_by || 'Unknown', hours_at_reset || null, notes || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ER LOG ANALYTICS ──────────────────────────────────────────────────────────
// GET /api/watches/analytics?vessel_id=X&fids=a,b,c&days=90
// Returns time-series data for given field IDs
router.get('/analytics', requireAuth, async (req, res) => {
  const { vessel_id, fids, days = 90 } = req.query;
  if (!vessel_id || !fids) return res.status(400).json({ error: 'vessel_id and fids required' });
  try {
    const fidList = fids.split(',').map(f => f.trim()).filter(Boolean).slice(0, 20);
    const { rows } = await pool.query(`
      SELECT
        w.watch_date::date   AS date,
        r.location_path      AS fid,
        r.parameter,
        r.unit_label         AS unit,
        r.section,
        r.equipment,
        AVG(r.value)::numeric(10,2) AS value
      FROM eom_readings r
      JOIN eom_watches w ON w.id = r.watch_id
      WHERE w.vessel_id = $1
        AND r.location_path = ANY($2)
        AND r.value IS NOT NULL
        AND w.watch_date >= CURRENT_DATE - ($3::int * INTERVAL '1 day')
      GROUP BY w.watch_date, r.location_path, r.parameter, r.unit_label, r.section, r.equipment
      ORDER BY w.watch_date, r.location_path
    `, [vessel_id, fidList, parseInt(days)]);

    // Structure: { fid -> { meta, points: [{date, value}] } }
    const series = {};
    rows.forEach(r => {
      if (!series[r.fid]) {
        series[r.fid] = {
          fid: r.fid, parameter: r.parameter, unit: r.unit,
          section: r.section, equipment: r.equipment, points: []
        };
      }
      series[r.fid].points.push({ date: r.date.toISOString().slice(0, 10), value: parseFloat(r.value) });
    });

    res.json({ series: Object.values(series) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/watches/field-catalog?vessel_id=X
// Returns all unique field IDs with metadata that have data
router.get('/field-catalog', requireAuth, async (req, res) => {
  const { vessel_id } = req.query;
  if (!vessel_id) return res.status(400).json({ error: 'vessel_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT
        r.location_path       AS fid,
        r.parameter,
        r.unit_label          AS unit,
        r.section,
        r.equipment,
        COUNT(*)::int         AS reading_count,
        MIN(w.watch_date)::date AS first_date,
        MAX(w.watch_date)::date AS last_date,
        AVG(r.value)::numeric(10,2) AS avg_value,
        MIN(r.value)::numeric(10,2) AS min_value,
        MAX(r.value)::numeric(10,2) AS max_value
      FROM eom_readings r
      JOIN eom_watches w ON w.id = r.watch_id
      WHERE w.vessel_id = $1 AND r.value IS NOT NULL
        AND r.location_path NOT LIKE 'rh_%'
        AND r.location_path NOT LIKE 'ch_%'
        AND r.location_path NOT LIKE 'gas_%'
        AND r.location_path NOT LIKE 'loi_%'
      GROUP BY r.location_path, r.parameter, r.unit_label, r.section, r.equipment
      HAVING COUNT(*) >= 3
      ORDER BY r.section, r.equipment, r.parameter
    `, [vessel_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORT — fetch readings by date range ────────────────────────────────────
// GET /api/watches/export?vessel_id=X&from=YYYY-MM-DD&to=YYYY-MM-DD&sections=a,b
router.get('/export', requireAuth, async (req, res) => {
  const { vessel_id, from, to, sections } = req.query;
  if (!vessel_id || !from || !to) return res.status(400).json({ error: 'vessel_id, from, to required' });
  try {
    const sectionList = sections ? sections.split(',') : null;
    const SECTION_MAP = {
      floor: 'ER Floor', deck3: '3rd Deck', deck2: '2nd Deck',
      upper: 'Upper Deck', tanks: 'Tanks', weekly: 'Weekly Tests',
      monthly: 'Monthly Logs', rh: 'Running Hours'
    };
    const sectionNames = sectionList ? sectionList.map(s => SECTION_MAP[s] || s) : null;

    let query = `
      SELECT
        TO_CHAR(w.watch_date, 'YYYY-MM-DD') AS date,
        r.section,
        r.equipment,
        r.parameter,
        r.unit_label        AS unit,
        r.location_path     AS fid,
        r.value,
        r.is_alarm,
        r.is_warning,
        w.duty_engineer
      FROM eom_readings r
      JOIN eom_watches w ON w.id = r.watch_id
      WHERE w.vessel_id = $1
        AND w.watch_date >= $2::date
        AND w.watch_date <= $3::date
        AND r.value IS NOT NULL
    `;
    const params = [vessel_id, from, to];
    if (sectionNames) {
      query += ` AND r.section = ANY($4)`;
      params.push(sectionNames);
    }
    query += ` ORDER BY w.watch_date, r.section, r.equipment, r.parameter`;

    const { rows } = await pool.query(query, params);
    res.json({ rows, from, to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
