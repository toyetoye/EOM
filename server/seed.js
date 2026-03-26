require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, initDB } = require('./db');

async function seed() {
  await initDB();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── System users ──────────────────────────────────────────────────────────
    const adminPw = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin@2025!', 10);
    await client.query(`
      INSERT INTO eom_users (username,password,role,display_name,active)
      VALUES ('admin',$1,'admin','Administrator',true)
      ON CONFLICT (username) DO UPDATE
        SET role='admin', display_name='Administrator'
    `, [adminPw]);

    const superPw = await bcrypt.hash('Super@2025!', 10);
    await client.query(`
      INSERT INTO eom_users (username,password,role,display_name,active)
      VALUES ('superintendent',$1,'superintendent','Superintendent',true)
      ON CONFLICT (username) DO UPDATE
        SET role='superintendent', display_name='Superintendent'
    `, [superPw]);

    // ── Vessels ───────────────────────────────────────────────────────────────
    const { rows: [at] } = await client.query(`
      INSERT INTO eom_vessels (name,imo,type,active)
      VALUES ('Alfred Temile','9859882','LPG',true)
      ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name
      RETURNING id
    `);
    const atId = at ? at.id : (await client.query("SELECT id FROM eom_vessels WHERE imo='9859882'")).rows[0].id;

    const { rows: [ph2] } = await client.query(`
      INSERT INTO eom_vessels (name,imo,type,active)
      VALUES ('LNG Port Harcourt 2','9370906','LNG',true)
      ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name
      RETURNING id
    `);
    const ph2Id = ph2 ? ph2.id : (await client.query("SELECT id FROM eom_vessels WHERE imo='9370906'")).rows[0].id;

    // ── Vessel login (system account — NOT a crew member) ─────────────────────
    const vesselPw = await bcrypt.hash('Vessel@2025!', 10);
    const { rows: [atUser] } = await client.query(`
      INSERT INTO eom_users (username,password,role,display_name,active)
      VALUES ('alfred_temile',$1,'vessel','Alfred Temile (Vessel)',true)
      ON CONFLICT (username) DO UPDATE SET role='vessel', display_name='Alfred Temile (Vessel)'
      RETURNING id
    `, [vesselPw]);
    if (atUser) {
      await client.query(`
        INSERT INTO eom_user_vessels (user_id,vessel_id)
        VALUES ($1,$2) ON CONFLICT DO NOTHING
      `, [atUser.id, atId]);
    }

    const { rows: [ph2User] } = await client.query(`
      INSERT INTO eom_users (username,password,role,display_name,active)
      VALUES ('lng_port_harcourt_2',$1,'vessel','LNG Port Harcourt 2 (Vessel)',true)
      ON CONFLICT (username) DO UPDATE SET role='vessel', display_name='LNG Port Harcourt 2 (Vessel)'
      RETURNING id
    `, [vesselPw]);
    if (ph2User) {
      await client.query(`
        INSERT INTO eom_user_vessels (user_id,vessel_id)
        VALUES ($1,$2) ON CONFLICT DO NOTHING
      `, [ph2User.id, ph2Id]);
    }

    await client.query('COMMIT');
    console.log('✅ Seed complete');
    console.log('');
    console.log('System accounts:');
    console.log('  admin          / Admin@2025!   (admin access)');
    console.log('  superintendent / Super@2025!   (superintendent)');
    console.log('  alfred_temile  / Vessel@2025!  (vessel login)');
    console.log('');
    console.log('👉 Log in as admin and go to /admin.html to add individual crew members');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed error:', e.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

seed();
