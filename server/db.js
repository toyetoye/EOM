const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {

    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS eom_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(200) NOT NULL,
        role VARCHAR(20) DEFAULT 'vessel',
        active BOOLEAN DEFAULT true,
        display_name VARCHAR(200),
        email VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS eom_user_vessels (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES eom_users(id) ON DELETE CASCADE,
        vessel_id INTEGER,
        UNIQUE(user_id, vessel_id)
      )
    `);

    // ── VESSELS ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS eom_vessels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        imo VARCHAR(20) UNIQUE,
        type VARCHAR(50) DEFAULT 'LPG',
        active BOOLEAN DEFAULT true
      )
    `);

    // ── WATCHES ──────────────────────────────────────────────────────────────
    // watch_number: 1=00-04  2=04-08  3=08-12  4=12-16  5=16-20  6=20-24
    await client.query(`
      CREATE TABLE IF NOT EXISTS eom_watches (
        id SERIAL PRIMARY KEY,
        vessel_id INTEGER REFERENCES eom_vessels(id) ON DELETE CASCADE,
        watch_date DATE NOT NULL,
        watch_number INTEGER NOT NULL CHECK (watch_number BETWEEN 1 AND 6),
        duty_engineer VARCHAR(200),
        submitted_by VARCHAR(200),
        submitted_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'draft',
        UNIQUE(vessel_id, watch_date, watch_number)
      )
    `);

    // ── READINGS ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS eom_readings (
        id SERIAL PRIMARY KEY,
        watch_id INTEGER REFERENCES eom_watches(id) ON DELETE CASCADE,
        location_path VARCHAR(500),
        section VARCHAR(200),
        equipment VARCHAR(200),
        parameter VARCHAR(200) NOT NULL,
        unit_label VARCHAR(50),
        value NUMERIC,
        value_text VARCHAR(200),
        is_alarm BOOLEAN DEFAULT false,
        is_warning BOOLEAN DEFAULT false
      )
    `);

    // ── RUNNING HOURS ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS eom_running_hours (
        id SERIAL PRIMARY KEY,
        watch_id INTEGER REFERENCES eom_watches(id) ON DELETE CASCADE,
        equipment VARCHAR(200) NOT NULL,
        hours NUMERIC,
        minutes INTEGER DEFAULT 0
      )
    `);

    // ── REMARKS ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS eom_remarks (
        id SERIAL PRIMARY KEY,
        watch_id INTEGER REFERENCES eom_watches(id) ON DELETE CASCADE,
        section VARCHAR(200),
        equipment VARCHAR(200),
        remark TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── LOG AMENDMENTS ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS eom_amendments (
        id SERIAL PRIMARY KEY,
        watch_id INTEGER REFERENCES eom_watches(id) ON DELETE CASCADE,
        amended_by VARCHAR(200),
        amended_at TIMESTAMP DEFAULT NOW(),
        reason TEXT
      )
    `);

    await addCycloneTable(client);
    await addDefectTables(client);
    await client.query('COMMIT');
    console.log('✅ EOM DB initialised');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('DB init error:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };

// Called by initDB — add cyclone filter table
async function addCycloneTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS eom_cyclone_resets (
      id          SERIAL PRIMARY KEY,
      vessel_id   INTEGER NOT NULL REFERENCES eom_vessels(id),
      dg_number   INTEGER NOT NULL,        -- 1, 2 or 3
      reset_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      reset_by    VARCHAR(100),
      hours_at_reset NUMERIC(10,1),        -- DG running hours at time of change
      notes       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cyclone_vessel_dg
      ON eom_cyclone_resets(vessel_id, dg_number);
  `);
}
module.exports.addCycloneTable = addCycloneTable;

async function addDefectTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS eom_defects (
      id                SERIAL PRIMARY KEY,
      vessel_id         INTEGER NOT NULL REFERENCES eom_vessels(id),
      ref_number        VARCHAR(30) UNIQUE,   -- auto-generated DEF-XXXX
      reported_by       VARCHAR(100) NOT NULL,
      date_reported     DATE NOT NULL DEFAULT CURRENT_DATE,
      location          VARCHAR(100),
      equipment         VARCHAR(150),
      description       TEXT NOT NULL,
      suggested_fix     TEXT,
      priority          VARCHAR(20) DEFAULT 'normal', -- low/normal/high/critical
      reported_to       VARCHAR(100),
      date_reported_to  DATE,
      expected_closeout DATE,
      date_closed       DATE,
      status            VARCHAR(30) DEFAULT 'open',   -- open/in_progress/closed/cancelled
      closed_by         VARCHAR(100),
      sire_relevant     BOOLEAN DEFAULT false,
      photo_paths       TEXT[],
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS eom_defect_comments (
      id          SERIAL PRIMARY KEY,
      defect_id   INTEGER NOT NULL REFERENCES eom_defects(id) ON DELETE CASCADE,
      author      VARCHAR(100) NOT NULL,
      role        VARCHAR(50),              -- vessel/superintendent/office
      comment     TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS eom_audit_log (
      id          SERIAL PRIMARY KEY,
      vessel_id   INTEGER REFERENCES eom_vessels(id),
      entity_type VARCHAR(50),             -- defect/watch/reading
      entity_id   INTEGER,
      action      VARCHAR(50),             -- created/updated/closed/amended
      changed_by  VARCHAR(100),
      changed_at  TIMESTAMP DEFAULT NOW(),
      old_value   JSONB,
      new_value   JSONB,
      ip_address  VARCHAR(45),
      user_agent  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_defects_vessel ON eom_defects(vessel_id);
    CREATE INDEX IF NOT EXISTS idx_defects_status  ON eom_defects(status);
    CREATE INDEX IF NOT EXISTS idx_audit_entity    ON eom_audit_log(entity_type, entity_id);

    -- Auto-generate ref number trigger
    CREATE OR REPLACE FUNCTION set_defect_ref()
    RETURNS TRIGGER AS \$\$
    BEGIN
      IF NEW.ref_number IS NULL THEN
        NEW.ref_number := 'DEF-' || LPAD(NEW.id::TEXT, 4, '0');
      END IF;
      RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_defect_ref ON eom_defects;
    CREATE TRIGGER trg_defect_ref
      BEFORE INSERT ON eom_defects
      FOR EACH ROW EXECUTE FUNCTION set_defect_ref();
  `);
}
module.exports.addDefectTables = addDefectTables;
