// eom-api.js — shared fetch helper
// Included via <script src="/eom-api.js"></script> in all pages

window.EOM = window.EOM || {};

EOM.token = () => localStorage.getItem('eom_token');
EOM.user  = () => { try { return JSON.parse(localStorage.getItem('eom_user')); } catch { return null; } };
EOM.logout = () => { localStorage.removeItem('eom_token'); localStorage.removeItem('eom_user'); location.href = '/'; };

EOM.api = async function(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + EOM.token()
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (res.status === 401) { EOM.logout(); return; }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

EOM.get  = (path)        => EOM.api('GET',    path);
EOM.post = (path, body)  => EOM.api('POST',   path, body);
EOM.put  = (path, body)  => EOM.api('PUT',    path, body);
EOM.del  = (path)        => EOM.api('DELETE', path);

// Guard: redirect to login if not authenticated
EOM.requireAuth = function(allowedRoles) {
  const u = EOM.user();
  if (!u || !EOM.token()) { location.href = '/'; return false; }
  if (allowedRoles && !allowedRoles.includes(u.role)) { location.href = '/'; return false; }
  return true;
};

// Watch number from current time
EOM.currentWatchNumber = function() {
  const h = new Date().getHours();
  if (h <  4) return 1;
  if (h <  8) return 2;
  if (h < 12) return 3;
  if (h < 16) return 4;
  if (h < 20) return 5;
  return 6;
};

EOM.watchLabel = (n) => (['','00–04','04–08','08–12','12–16','16–20','20–24'])[n] || '';

// Today as YYYY-MM-DD
EOM.today = () => new Date().toISOString().slice(0,10);
