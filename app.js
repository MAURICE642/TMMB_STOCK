/* ═══════════════════════════════════════════════════
   TRIOMPHANT — STOCK · utilitaires communs (script classique)
   Même organisation que l'application de comptabilité :
   app.js (utilitaires) + app-firebase.js (Firebase et logique).
═══════════════════════════════════════════════════ */

/* ─── Échappement HTML (protection XSS) ─── */
function esc(s){
  if(s==null) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

/* ─── Identifiant sûr à placer dans un onclick (ID Firestore) ─── */
function sid(s){ return /^[A-Za-z0-9_-]{1,120}$/.test(String(s||'')) ? String(s) : ''; }

/* ─── Session (cache d'affichage seulement, jamais de mot de passe) ─── */
function getCurrentUser(){
  try{ return JSON.parse(sessionStorage.getItem('triomphant_stock_user')||'null'); }
  catch(e){ return null; }
}
function setCurrentUser(user){
  if(user) sessionStorage.setItem('triomphant_stock_user', JSON.stringify(user));
  else sessionStorage.removeItem('triomphant_stock_user');
}

/* ─── Formats ─── */
const fmtN = v => Number(v||0).toLocaleString('fr-FR');
const fmtF = v => Math.round(Number(v||0)).toLocaleString('fr-FR') + ' FCFA';
function dateFr(d){
  if(!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return d || '—';
  const [y,m,j] = d.split('-'); return `${j}/${m}/${y}`;
}
function aujourdhui(){
  // Date locale de l'appareil (Bénin, UTC+1), pas la date UTC.
  const n = new Date();
  return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');
}

/* ─── Message bref ─── */
/* ─── Icône (jeu d'icônes défini en haut de index.html) ─── */
function icone(nom){ return '<svg class="i" aria-hidden="true"><use href="#i-' + nom + '"/></svg>'; }

function notify(msg, type){
  const t = document.getElementById('toast');
  if(!t) return;
  // Le texte est inséré comme texte (jamais comme HTML) ; seule l'icône est du HTML fixe.
  const ic = { err:'alert', warn:'alert', info:'info' }[type] || 'check';
  t.innerHTML = icone(ic) + '<span></span>';
  t.lastChild.textContent = String(msg).replace(/^[\u2600-\u27BF\u{1F300}-\u{1FAFF}]\uFE0F?\s*/u, '');
  t.className = 'show t-' + (type||'ok');
  clearTimeout(t._tm);
  t._tm = setTimeout(()=>{ t.className=''; }, type==='err' ? 6000 : 3500);
}

/* ─── Barre latérale mobile ─── */
function toggleMobileSidebar(force){
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebar-backdrop');
  if(!sb||!bd) return;
  const show = typeof force==='boolean' ? force : !sb.classList.contains('open');
  sb.classList.toggle('open', show);
  bd.classList.toggle('open', show);
}

/* ─── Modales ─── */
function ouvrirModale(id){ const m=document.getElementById(id); if(m) m.classList.remove('hidden'); }
function fermerModale(id){ const m=document.getElementById(id); if(m) m.classList.add('hidden'); }

/* ─── Export CSV (séparateur ; pour Excel français) ─── */
function telechargerCsv(nom, lignes){
  const csv = lignes.map(r => r.map(v => {
    const s = String(v==null?'':v);
    return /[;"\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  }).join(';')).join('\n');
  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nom;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}
