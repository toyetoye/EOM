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
    // All 13 fleet vessels — upsert by IMO
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('Aktoras','9958286','LNG','2-STROKE','AKTORAS',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('Axios II','9943853','LNG','2-STROKE','AKTORAS',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG Adamawa','9262211','LNG','STEAM','RIVERS',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG Akwa-Ibom','9262209','LNG','STEAM','RIVERS',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG River Niger','9262235','LNG','STEAM','RIVERS',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG Cross-River','9262223','LNG','STEAM','RIVERS',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG Sokoto','9216303','LNG','STEAM','RIVERS PLUS',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG Finima II','9690145','LNG','DFDE','SHI',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG Portharcourt II','9690157','LNG','DFDE','SHI',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG Bonny II','9692002','LNG','DFDE','HHI',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('LNG Lagos II','9692014','LNG','DFDE','HHI',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('Alfred Temile','9859882','LPG','2-STROKE','AT',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    await client.query("INSERT INTO eom_vessels (name,imo,type,propulsion_type,vessel_class,active) VALUES ('Alfred Temile 10','9937127','LPG','2-STROKE','AT10',true) ON CONFLICT (imo) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type,propulsion_type=EXCLUDED.propulsion_type,vessel_class=EXCLUDED.vessel_class");
    const atRow  = await client.query("SELECT id FROM eom_vessels WHERE imo='9859882'");
    const atId   = atRow.rows[0]?.id;
    const ph2Row = await client.query("SELECT id FROM eom_vessels WHERE imo='9690157'");
    const ph2Id  = ph2Row.rows[0]?.id;
    
    // ── Vessel login (system account — NOT a crew member) ─────────────────────
    const vesselPw = await bcrypt.hash('Vessel@2025!', 10);
    const smtPw    = await bcrypt.hash('SMT@2025!', 10);
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

    // ── SMT (Chief Engineer) login for Alfred Temile ──────────────────────────
    const { rows: [atSmt] } = await client.query(
      "INSERT INTO eom_users (username,password,role,display_name,active) VALUES ('alfred_temile_ce',$1,'smt','Alfred Temile (C/E)',true) ON CONFLICT (username) DO UPDATE SET role='smt', display_name='Alfred Temile (C/E)' RETURNING id",
      [smtPw]
    );
    if (atSmt) {
      await client.query(
        'INSERT INTO eom_user_vessels (user_id,vessel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [atSmt.id, atId]
      );
    }

    // ── Seed duty engineers for Alfred Temile ─────────────────────────────────
    for (const de of [
      { rank:'2nd Engineer',        name:'Michael Okafor',       ord:1 },
      { rank:'3rd Engineer',        name:'Emmanuel Nwachukwu',   ord:2 },
      { rank:'4th Engineer',        name:'Samuel Adeyemi',       ord:3 },
      { rank:'Electrical Officer',  name:'Chukwuemeka Eze',      ord:4 },
    ]) {
      await client.query(
        'INSERT INTO vessel_duty_engineers (vessel_id,rank,name,display_order,active) VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING',
        [atId, de.rank, de.name, de.ord]
      );
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
    console.log('  alfred_temile     / Vessel@2025!  (vessel D/E login)');
    console.log('  alfred_temile_ce  / SMT@2025!     (vessel SMT/CE login)');
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
