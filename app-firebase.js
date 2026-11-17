/* ═══════════════════════════════════════════════════
   TRIOMPHANT — STOCK · Firebase et logique de l'application
   ---------------------------------------------------
   Même projet Firebase que TMMB (triomphant-v2), mêmes comptes.

   DONNÉES TMMB — LECTURE SEULE, JAMAIS MODIFIÉES :
     articles, agences, commerciaux, produits, livraisons, clients
   DONNÉES DU STOCK — collections propres, indépendantes du passé :
     stk_stock        un document par couple agence/article : { agenceId, articleId, qty }
     stk_articles     réglages par article TMMB : { prixAchat, seuil }
     stk_mouvements   journal de TOUS les changements de stock (jamais modifié)
     stk_inventaires  inventaires (brouillon puis validé)
     stk_livTraitees  une fiche par livraison TMMB traitée (empêche les doublons)
     stk_config       reglages (jour J, admin) · curseurLivraisons (dernière lecture)
═══════════════════════════════════════════════════ */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, getDocs, getDoc, doc, setDoc, updateDoc, query, where, limit,
         serverTimestamp, Timestamp, increment, writeBatch, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { cleStock, analyserLivraison, syntheseMouvements, calculInventaire,
         quantiteValide, compteValide, prixValide, estLivree } from "./stock-logic.js";

/* ═══════════════════════════════════════════════════
   CONFIGURATION (identique à l'application de comptabilité)
═══════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyATa_tOvEbGROCIZ9xZgkAsr_--d2vYIjc",
  authDomain: "triomphant-v2.firebaseapp.com",
  projectId: "triomphant-v2",
  storageBucket: "triomphant-v2.firebasestorage.app",
  messagingSenderId: "908578874554",
  appId: "1:908578874554:web:5c008fba39204ce6c24e83",
  measurementId: "G-STQHJF83X2"
};
const VALID_ROLES = ['admin','gestionnaire_stock'];
const MAX_LIGNES = 150;          // une entrée/un transfert = au plus 150 articles (limite d'écriture groupée Firestore)
const INV_PAQUET = 120;          // validation d'inventaire par paquets de 120 articles

const _fbApp = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
const db = getFirestore(_fbApp);
const auth = getAuth(_fbApp);

/* ═══════════════════════════════════════════════════
   ÉTAT
═══════════════════════════════════════════════════ */
const TDB = { articles:[], agences:[], commerciaux:[] };
const IDX = { articles:new Map(), agences:new Map(), commerciaux:new Map(), produits:null };
const STK = {
  stock: new Map(),        // cleStock → qty
  reglArt: new Map(),      // articleId → { prixAchat, seuil }
  jourJ: '',
  curseur: null,           // { ms, jourJ, majLe }
  inventaires: [],
  aVerifier: [],
  derniereLecture: null    // résumé de la dernière lecture des livraisons
};
let curPg = 'dashboard';
let _bootEnCours = false, _appDemarree = false, _livEnCours = false;
const _verrous = new Set();

const PAGE_TITLES = {
  dashboard:"Vue d'ensemble", stock:'Stock par agence', articles:'Articles',
  entrees:'Entrées fournisseurs', transferts:'Transferts', inventaires:'Inventaires',
  livraisons:'Livraisons TMMB', mouvements:'Mouvements & rapports', reglages:'Réglages'
};

const user = () => getCurrentUser() || {};
const estAdmin = () => user().role === 'admin';
const auteur = () => ({ auteurId: user().id || '', auteurNom: user().name || '' });
const nomArt = id => (IDX.articles.get(id) || {}).nom || '(article supprimé dans TMMB)';
const nomAg  = id => (IDX.agences.get(id) || {}).nom || '(agence inconnue)';
const qte    = (ag, art) => STK.stock.get(cleStock(ag, art)) || 0;
const articlesTries = () => [...TDB.articles].sort((a,b)=>String(a.nom||'').localeCompare(String(b.nom||''),'fr'));
const agencesTriees = () => [...TDB.agences].sort((a,b)=>String(a.nom||'').localeCompare(String(b.nom||''),'fr'));

function prixAchat(id){
  const r = STK.reglArt.get(id);
  if(r && r.prixAchat != null && r.prixAchat !== '') return { v:Number(r.prixAchat)||0, src:'stock' };
  const a = IDX.articles.get(id);
  if(a && a.pa != null && a.pa !== '') return { v:Number(a.pa)||0, src:'tmmb' };
  return { v:0, src:'aucun' };
}
function seuil(id){
  const r = STK.reglArt.get(id);
  if(r && r.seuil != null && r.seuil !== '') return Number(r.seuil)||0;
  return Number((IDX.articles.get(id)||{}).stockMin) || 0;
}
function stockTotal(art){ return TDB.agences.reduce((s,a)=>s+qte(a._id, art), 0); }

// Empêche un double clic de lancer deux fois la même écriture.
async function avecVerrou(cle, btnId, fn){
  if(_verrous.has(cle)) return;
  _verrous.add(cle);
  const b = btnId && document.getElementById(btnId);
  const txt = b && b.textContent;
  if(b){ b.disabled = true; b.textContent = '⏳ Enregistrement…'; }
  try{ return await fn(); }
  finally{ _verrous.delete(cle); if(b){ b.disabled = false; b.textContent = txt; } }
}
function msgErreur(e){
  const s = String((e && (e.code || e.message)) || e || '');
  if(s.includes('permission')) return "Accès refusé par Firebase : les règles stk_ sont-elles publiées ? (voir REGLES-FIRESTORE-stock.txt)";
  if(s.includes('unavailable') || s.includes('network') || s.includes('offline')) return 'Pas de connexion internet : rien n\'a été enregistré, réessayez.';
  return 'Erreur : ' + s;
}
function setSync(ok, txt){
  const d = document.getElementById('sync-dot'); const l = document.getElementById('sync-label');
  if(d) d.style.background = ok ? 'var(--accent2)' : 'var(--danger)';
  if(l) l.textContent = txt || (ok ? 'Connecté' : 'Hors ligne');
}

/* ═══════════════════════════════════════════════════
   CONNEXION — même mécanisme que TMMB et la comptabilité
   (verrou anti-brute-force local + collection partagée loginAttempts)
═══════════════════════════════════════════════════ */
const _LGA_PALIERS = [60000, 300000, 1800000, 7200000];
const _lgaKey = k => '_lga_stock_' + k.replace(/[^a-z0-9._-]/gi,'_');
function _getAtt(k){ try{ return JSON.parse(localStorage.getItem(_lgaKey(k)) || '{"count":0,"until":0,"cycles":0}'); }catch(e){ return {count:0,until:0,cycles:0}; } }
function _setAtt(k,v){ try{ localStorage.setItem(_lgaKey(k), JSON.stringify(v)); }catch(e){} }
const _lgsKey = e => e.replace(/[^a-z0-9._-]/gi,'_').slice(0,100);
async function _lireVerrouServeur(email){
  try{ const s = await getDoc(doc(db,'loginAttempts',_lgsKey(email))); return s.exists() ? s.data() : null; }catch(e){ return null; }
}
async function _incVerrouServeur(email){
  try{
    const ref = doc(db,'loginAttempts',_lgsKey(email));
    const s = await getDoc(ref);
    if(!s.exists()) return void await setDoc(ref, { count:1, windowStart:new Date() });
    const d = s.data();
    const ws = d.windowStart && d.windowStart.toDate ? d.windowStart.toDate() : new Date(d.windowStart);
    if(Date.now() - ws.getTime() > 60000) await setDoc(ref, { count:1, windowStart:new Date() });
    else await updateDoc(ref, { count:(d.count||0)+1 });
  }catch(e){}
}
async function _resetVerrouServeur(email){
  try{ await setDoc(doc(db,'loginAttempts',_lgsKey(email)), { count:0, windowStart:new Date() }); }catch(e){}
}
async function _profil(uid, email){
  try{ const s = await getDoc(doc(db,'commerciaux',uid)); if(s.exists()) return { ...s.data(), _id:s.id }; }catch(e){}
  try{
    const q = await getDocs(query(collection(db,'commerciaux'), where('email','==',email), limit(1)));
    if(!q.empty) return { ...q.docs[0].data(), _id:q.docs[0].id };
  }catch(e){}
  return null;
}

// Déconnexion automatique après 30 min d'inactivité.
const SESSION_MS = 30*60*1000;
let _tSession = null, _tAvert = null;
function _relancerSession(){
  if(!getCurrentUser()) return;
  clearTimeout(_tSession); clearTimeout(_tAvert);
  _tAvert = setTimeout(()=>{ if(getCurrentUser()) notify('⚠️ Session inactive — déconnexion dans 2 minutes','warn'); }, SESSION_MS - 120000);
  _tSession = setTimeout(()=>{ if(getCurrentUser()){ notify('🔒 Session expirée','err'); window.doLogout(true); } }, SESSION_MS);
}
['click','keydown','touchstart'].forEach(ev => document.addEventListener(ev, ()=>{ if(getCurrentUser()) _relancerSession(); }, {passive:true}));

async function _ouvrirSession(fbUser, emailSaisi){
  const email = (emailSaisi || fbUser.email || '').toLowerCase();
  const p = await _profil(fbUser.uid, email);
  if(!p){ await fbSignOut(auth); throw new Error("Profil introuvable dans TMMB. Contactez l'administrateur."); }
  if(!VALID_ROLES.includes(p.role)){ await fbSignOut(auth); throw new Error(`Accès refusé — le rôle « ${p.role || 'vide'} » n'a pas accès au stock.`); }
  setCurrentUser({ id:fbUser.uid, name:p.nom || p.name || email, email, role:p.role });
  _relancerSession();
  document.getElementById('load-text').textContent = 'Chargement du stock…';
  await chargerTout();
  demarrerApp();
  // Les livraisons sont lues APRÈS l'affichage : l'application reste utilisable pendant ce temps.
  relireLivraisons(false);
}

window.doLogin = async function(){
  const email = (document.getElementById('login-email').value || '').trim().toLowerCase();
  const pwd = document.getElementById('login-password').value;
  const err = document.getElementById('login-err');
  err.style.display = 'none';
  if(!email || !pwd){ err.textContent = 'Veuillez saisir votre email et votre mot de passe.'; err.style.display = 'block'; return; }
  const now = Date.now();
  const att = _getAtt(email);
  if(att.until > now){
    const s = Math.ceil((att.until-now)/1000);
    err.textContent = `🔒 Trop de tentatives — réessayez dans ${s>90 ? Math.ceil(s/60)+' min' : s+' s'}`;
    err.style.display = 'block'; return;
  }
  const vs = await _lireVerrouServeur(email);
  if(vs && vs.count >= 5){
    const ws = vs.windowStart && vs.windowStart.toDate ? vs.windowStart.toDate() : new Date(vs.windowStart);
    const ecoule = Date.now() - ws.getTime();
    if(ecoule < 60000){ err.textContent = `🔒 Trop de tentatives — réessayez dans ${Math.ceil((60000-ecoule)/1000)} s`; err.style.display = 'block'; return; }
  }
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('loading-screen').classList.remove('hidden');
  document.getElementById('load-text').textContent = 'Connexion…';
  _bootEnCours = true;
  try{
    const cred = await signInWithEmailAndPassword(auth, email, pwd);
    _setAtt(email, {count:0, until:0, cycles:0});
    await _resetVerrouServeur(email);
    await _ouvrirSession(cred.user, email);
  }catch(e){
    _bootEnCours = false;
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    const identifiants = ['auth/wrong-password','auth/invalid-credential','auth/user-not-found'].includes(e.code);
    if(identifiants){
      att.count = (att.count||0) + 1;
      if(att.count >= 5){ att.until = now + _LGA_PALIERS[Math.min(att.cycles||0, _LGA_PALIERS.length-1)]; att.cycles = (att.cycles||0)+1; att.count = 0; }
      _setAtt(email, att);
      await _incVerrouServeur(email);
    }
    let msg = e.message || 'Connexion impossible.';
    if(identifiants) msg = att.until > now ? '🔒 Trop de tentatives — compte bloqué temporairement' : `❌ Email ou mot de passe incorrect (${att.count}/5)`;
    else if(e.code === 'auth/invalid-email') msg = '❌ Adresse email invalide.';
    else if(e.code === 'auth/too-many-requests') msg = '🔒 Trop de tentatives — Firebase a bloqué temporairement ce compte.';
    else if(e.code === 'auth/network-request-failed') msg = '📡 Pas de connexion internet.';
    err.textContent = msg; err.style.display = 'block';
  }
};

window.doLogout = async function(silencieux){
  if(!silencieux && !confirm('Se déconnecter ?')) return;
  setCurrentUser(null);
  try{ await fbSignOut(auth); }catch(e){}
  location.reload();
};

onAuthStateChanged(auth, async (u) => {
  if(u){
    if(_bootEnCours || _appDemarree) return;
    _bootEnCours = true;
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('loading-screen').classList.remove('hidden');
    document.getElementById('load-text').textContent = 'Reconnexion…';
    try{ await _ouvrirSession(u); }
    catch(e){
      _bootEnCours = false;
      document.getElementById('loading-screen').classList.add('hidden');
      document.getElementById('auth-screen').classList.remove('hidden');
      const err = document.getElementById('login-err');
      if(err){ err.textContent = e.message || 'Reconnexion impossible.'; err.style.display = 'block'; }
    }
  } else {
    setCurrentUser(null);
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
  }
});

/* ═══════════════════════════════════════════════════
   CHARGEMENT
   Lectures par ouverture : articles + agences + commerciaux (TMMB)
   + stk_stock + stk_articles + inventaires + livraisons à vérifier.
   Les mouvements et l'historique ne sont lus qu'à la demande, par période.
═══════════════════════════════════════════════════ */
const _docs = snap => snap.docs.map(d => ({ ...d.data(), _id:d.id }));

async function chargerTout(){
  const [arts, ags, coms, stk, regl, cfg, cur, invs, aver] = await Promise.all([
    getDocs(collection(db,'articles')),
    getDocs(collection(db,'agences')),
    getDocs(collection(db,'commerciaux')),
    getDocs(collection(db,'stk_stock')),
    getDocs(collection(db,'stk_articles')),
    getDoc(doc(db,'stk_config','reglages')),
    getDoc(doc(db,'stk_config','curseurLivraisons')),
    getDocs(collection(db,'stk_inventaires')),
    getDocs(query(collection(db,'stk_livTraitees'), where('statut','in',['a_verifier','annulee_apres_deduction'])))
  ]);
  TDB.articles = _docs(arts);
  TDB.agences = _docs(ags);
  TDB.commerciaux = _docs(coms);
  IDX.articles = new Map(TDB.articles.map(a=>[a._id,a]));
  IDX.agences = new Map(TDB.agences.map(a=>[a._id,a]));
  IDX.commerciaux = new Map(TDB.commerciaux.map(c=>[c._id,c]));
  STK.stock = new Map(_docs(stk).map(s=>[cleStock(s.agenceId, s.articleId), Number(s.qty)||0]));
  STK.reglArt = new Map(_docs(regl).map(r=>[r._id, r]));
  STK.jourJ = (cfg.exists() && cfg.data().jourJ) || '';
  STK.curseur = cur.exists() ? cur.data() : null;
  STK.inventaires = _docs(invs).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || String(b._id).localeCompare(String(a._id)));
  STK.aVerifier = _docs(aver).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  const n = new Date();
  document.getElementById('last-sync-label').textContent = 'Actualisé à ' + String(n.getHours()).padStart(2,'0') + ':' + String(n.getMinutes()).padStart(2,'0');
  setSync(true);
}

function demarrerApp(){
  _appDemarree = true; _bootEnCours = false;
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  const u = user();
  document.getElementById('user-avatar').textContent = String(u.name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
  document.getElementById('user-badge-name').textContent = (u.name||'') + (u.role === 'admin' ? ' 🛡️' : ' 📦');
  document.getElementById('nav-section-admin').style.display = estAdmin() ? '' : 'none';
  document.getElementById('nav-reglages').style.display = estAdmin() ? '' : 'none';
  remplirSelects();
  const t = aujourdhui();
  ['en-date','tr-date'].forEach(id => { const el = document.getElementById(id); if(el && !el.value) el.value = t; });
  const debMois = t.slice(0,8) + '01';
  if(!document.getElementById('mv-du').value){ document.getElementById('mv-du').value = debMois; document.getElementById('mv-au').value = t; }
  if(!document.getElementById('liv-du').value){
    const d = new Date(); d.setDate(d.getDate()-30);
    document.getElementById('liv-du').value = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    document.getElementById('liv-au').value = t;
  }
  if(!document.getElementById('en-lignes').children.length) ajouterLigne('en');
  if(!document.getElementById('tr-lignes').children.length) ajouterLigne('tr');
  majBandeau();
  go(curPg);
}

function majBandeau(){
  document.getElementById('topbar-jourj').textContent = 'Jour J : ' + (STK.jourJ ? dateFr(STK.jourJ) : 'non défini');
  const b = document.getElementById('badge-averifier');
  if(b){ b.textContent = STK.aVerifier.length; b.style.display = STK.aVerifier.length ? '' : 'none'; }
}

function remplirSelects(){
  const ags = agencesTriees();
  const opts = ags.map(a=>`<option value="${esc(a._id)}">${esc(a.nom||a._id)}${a.ville ? ' — '+esc(a.ville) : ''}</option>`).join('');
  const choix = '<option value="">— Choisir —</option>';
  document.getElementById('st-agence').innerHTML = '<option value="">Toutes les agences</option>' + opts;
  document.getElementById('mv-agence').innerHTML = '<option value="">Toutes les agences</option>' + opts;
  ['en-agence','tr-source','tr-dest','inv-new-agence'].forEach(id => {
    const el = document.getElementById(id); const v = el.value;
    el.innerHTML = choix + opts; if(v) el.value = v;
  });
}

window.syncNow = async function(){
  try{
    await chargerTout(); remplirSelects(); majBandeau();
    await relireLivraisons(false);
    renderPg(curPg);
    notify('✅ Données actualisées');
  }catch(e){ setSync(false); notify(msgErreur(e),'err'); }
};

/* ═══════════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════════ */
window.go = function(pg){
  if(pg === 'reglages' && !estAdmin()) pg = 'dashboard';
  curPg = pg;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const p = document.getElementById('page-'+pg); if(p) p.classList.add('active');
  const n = document.getElementById('nav-'+pg); if(n) n.classList.add('active');
  document.getElementById('topbar-title').textContent = PAGE_TITLES[pg] || pg;
  renderPg(pg);
  if(window.innerWidth <= 860) toggleMobileSidebar(false);
  const c = document.getElementById('content'); if(c) c.scrollTop = 0;
};
function renderPg(pg){
  try{
    if(pg==='dashboard') renderDashboard();
    else if(pg==='stock') renderStock();
    else if(pg==='articles') renderArticles();
    else if(pg==='entrees'){ majTotalEntree(); chargerHistorique('entree','en-histo'); }
    else if(pg==='transferts'){ majLignesTransfert(); chargerHistorique('transfert','tr-histo'); }
    else if(pg==='inventaires') renderInventaires();
    else if(pg==='livraisons'){ renderAVerifier(); chargerLivTraitees(); }
    else if(pg==='mouvements') chargerMouvements();
    else if(pg==='reglages') document.getElementById('rg-jourj').value = STK.jourJ || '';
  }catch(e){ console.error(e); notify('Erreur d\'affichage : ' + e.message,'err'); }
}

/* ═══════════════════════════════════════════════════
   VUE D'ENSEMBLE
═══════════════════════════════════════════════════ */
function lignesStockBas(){
  const out = [];
  for(const ag of TDB.agences) for(const a of TDB.articles){
    const s = seuil(a._id); if(!(s > 0)) continue;
    const q = qte(ag._id, a._id);
    if(q < s) out.push({ ag, a, q, s });
  }
  return out.sort((x,y)=>(x.q - x.s) - (y.q - y.s));
}
function renderDashboard(){
  const conf = document.getElementById('dash-alerte-config');
  const sansDepart = TDB.agences.filter(ag => !STK.inventaires.some(i => i.agenceId === ag._id && i.statut === 'valide'));
  let html = '';
  if(!STK.jourJ) html += `<div class="alert alert-warn">📅 Le <b>jour J</b> n'est pas défini : les livraisons TMMB ne sont pas encore déduites du stock. ${estAdmin() ? '<a href="#" onclick="go(\'reglages\');return false;">Le définir</a>' : "Demandez à l'administrateur de le définir."}</div>`;
  if(sansDepart.length) html += `<div class="alert alert-info">📋 ${sansDepart.length} agence(s) sans inventaire de départ : ${sansDepart.map(a=>esc(a.nom)).join(', ')}. <a href="#" onclick="go('inventaires');return false;">Faire l'inventaire</a></div>`;
  conf.innerHTML = html;

  let valeur = 0;
  for(const ag of TDB.agences) for(const a of TDB.articles) valeur += Math.max(0, qte(ag._id, a._id)) * prixAchat(a._id).v;
  const bas = lignesStockBas();
  const neg = [...STK.stock.values()].filter(q => q < 0).length;
  document.getElementById('dash-kpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-lbl">Valeur du stock</div><div class="kpi-val kv-green">${fmtF(valeur)}</div><div class="kpi-sub">au prix d'achat</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Stock bas</div><div class="kpi-val ${bas.length?'kv-red':'kv-green'}">${bas.length}</div><div class="kpi-sub">article(s) × agence sous le seuil</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Stock négatif</div><div class="kpi-val ${neg?'kv-red':'kv-green'}">${neg}</div><div class="kpi-sub">à corriger par un inventaire</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Livraisons à vérifier</div><div class="kpi-val ${STK.aVerifier.length?'kv-yellow':'kv-green'}">${STK.aVerifier.length}</div><div class="kpi-sub">non déduites automatiquement</div></div>`;

  document.getElementById('dash-bas').innerHTML = bas.length
    ? '<table class="mini-table" style="width:100%;">' + bas.slice(0,15).map(r => `<tr><td>${esc(r.a.nom)}</td><td class="muted">${esc(r.ag.nom)}</td><td class="qte-bas" style="text-align:right;">${fmtN(r.q)} / ${fmtN(r.s)}</td></tr>`).join('') + '</table>' + (bas.length > 15 ? `<div class="muted" style="margin-top:6px;">… et ${bas.length-15} autre(s) — voir « Stock par agence ».</div>` : '')
    : '<div class="muted">Aucun article sous son seuil.</div>';

  document.getElementById('dash-agences').innerHTML = TDB.agences.length
    ? '<table class="mini-table" style="width:100%;">' + agencesTriees().map(ag => {
        let v = 0; for(const a of TDB.articles) v += Math.max(0, qte(ag._id, a._id)) * prixAchat(a._id).v;
        return `<tr><td>${esc(ag.nom)}</td><td style="text-align:right;font-weight:700;">${fmtF(v)}</td></tr>`;
      }).join('') + '</table>'
    : '<div class="muted">Aucune agence dans TMMB.</div>';

  const d = STK.derniereLecture;
  document.getElementById('dash-liv').innerHTML = !STK.jourJ ? '<div class="muted">Jour J non défini.</div>'
    : d ? `<div style="font-size:13px;">${esc(d.heure)} — ${d.lues} livraison(s) relue(s), <b>${d.deduites}</b> déduite(s), ${d.aVerifier} à vérifier${d.erreur ? ` · <span class="kv-red">${esc(d.erreur)}</span>` : ''}.</div>`
    : '<div class="muted">Lecture en cours…</div>';
}

/* ═══════════════════════════════════════════════════
   STOCK PAR AGENCE
═══════════════════════════════════════════════════ */
function filtreArticles(txt){
  const t = String(txt||'').trim().toLowerCase();
  return articlesTries().filter(a => !t || String(a.nom||'').toLowerCase().includes(t) || String(a.ref||'').toLowerCase().includes(t) || String(a.cat||'').toLowerCase().includes(t));
}
window.renderStock = function(){
  const ag = document.getElementById('st-agence').value;
  const bas = document.getElementById('st-bas').checked;
  let arts = filtreArticles(document.getElementById('st-search').value);
  const ags = ag ? [IDX.agences.get(ag)].filter(Boolean) : agencesTriees();
  if(bas) arts = arts.filter(a => ags.some(g => seuil(a._id) > 0 && qte(g._id, a._id) < seuil(a._id)));
  const cls = (q, s) => q < 0 ? 'qte-neg' : (s > 0 && q < s ? 'qte-bas' : '');
  let valeur = 0, unites = 0;
  if(ag){
    document.getElementById('st-head').innerHTML = '<tr><th>Réf.</th><th>Article</th><th>Quantité</th><th>Seuil</th><th>Prix d\'achat</th><th>Valeur</th></tr>';
    document.getElementById('st-body').innerHTML = arts.map(a => {
      const q = qte(ag, a._id), p = prixAchat(a._id), s = seuil(a._id), v = Math.max(0,q) * p.v;
      valeur += v; unites += q;
      return `<tr><td class="muted">${esc(a.ref)}</td><td>${esc(a.nom)}</td><td class="${cls(q,s)}">${fmtN(q)} ${esc(a.unite||'')}</td><td>${s ? fmtN(s) : '—'}</td><td>${fmtF(p.v)}${p.src==='tmmb' ? ' <span class="muted">(TMMB)</span>' : ''}</td><td>${fmtF(v)}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="emp">Aucun article.</td></tr>';
  } else {
    document.getElementById('st-head').innerHTML = '<tr><th>Article</th>' + ags.map(g=>`<th>${esc(g.nom)}</th>`).join('') + '<th>Total</th><th>Valeur</th></tr>';
    const tot = new Map();
    document.getElementById('st-body').innerHTML = arts.map(a => {
      const s = seuil(a._id); let t = 0;
      const cells = ags.map(g => { const q = qte(g._id, a._id); t += q; tot.set(g._id, (tot.get(g._id)||0) + q); return `<td class="${cls(q,s)}">${fmtN(q)}</td>`; }).join('');
      const v = Math.max(0,t) * prixAchat(a._id).v; valeur += v; unites += t;
      return `<tr><td>${esc(a.nom)} <span class="muted">${esc(a.ref||'')}</span></td>${cells}<td style="font-weight:700;">${fmtN(t)}</td><td>${fmtF(v)}</td></tr>`;
    }).join('') + (arts.length ? `<tr class="st-total"><td>TOTAL</td>${ags.map(g=>`<td>${fmtN(tot.get(g._id)||0)}</td>`).join('')}<td>${fmtN(unites)}</td><td>${fmtF(valeur)}</td></tr>` : '<tr><td colspan="9" class="emp">Aucun article.</td></tr>');
  }
  document.getElementById('st-kpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-lbl">Articles affichés</div><div class="kpi-val kv-blue">${arts.length}</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Unités en stock</div><div class="kpi-val kv-purple">${fmtN(unites)}</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Valeur (prix d'achat)</div><div class="kpi-val kv-green">${fmtF(valeur)}</div></div>`;
};
window.exportStockCsv = function(){
  const ags = agencesTriees();
  const rows = [['Référence','Article','Unité', ...ags.map(a=>a.nom), 'Total', "Prix d'achat", 'Valeur']];
  for(const a of articlesTries()){
    const qs = ags.map(g=>qte(g._id, a._id)); const t = qs.reduce((x,y)=>x+y,0); const p = prixAchat(a._id).v;
    rows.push([a.ref||'', a.nom||'', a.unite||'', ...qs, t, p, Math.max(0,t)*p]);
  }
  telechargerCsv('stock_' + aujourdhui() + '.csv', rows);
};

/* ═══════════════════════════════════════════════════
   ARTICLES (réglages propres au stock)
═══════════════════════════════════════════════════ */
let _artEdite = null;
window.renderArticles = function(){
  const arts = filtreArticles(document.getElementById('art-search').value);
  document.getElementById('art-body').innerHTML = arts.map(a => {
    const p = prixAchat(a._id), s = seuil(a._id), id = sid(a._id);
    return `<tr><td class="muted">${esc(a.ref)}</td><td>${esc(a.nom)}</td><td>${esc(a.cat||'—')}</td><td>${esc(a.unite||'—')}</td>
      <td>${fmtF(p.v)}${p.src==='tmmb' ? ' <span class="muted">(TMMB)</span>' : p.src==='aucun' ? ' <span class="muted">(non défini)</span>' : ''}</td>
      <td>${s ? fmtN(s) : '—'}</td><td>${fmtN(stockTotal(a._id))}</td>
      <td class="no-print">${id ? `<button class="btn btn-ghost btn-xs" onclick="ouvrirArticle('${id}')">✏️ Régler</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="emp">Aucun article dans TMMB.</td></tr>';
};
window.ouvrirArticle = function(id){
  const a = IDX.articles.get(id); if(!a) return;
  _artEdite = id;
  const r = STK.reglArt.get(id) || {};
  document.getElementById('ma-titre').textContent = '🏷️ ' + (a.nom || id);
  document.getElementById('ma-prix').value = r.prixAchat ?? '';
  document.getElementById('ma-seuil').value = r.seuil ?? '';
  ouvrirModale('modal-article');
};
window.enregistrerArticle = async function(){
  const id = _artEdite; if(!id) return;
  const pv = document.getElementById('ma-prix').value.trim(), sv = document.getElementById('ma-seuil').value.trim();
  if(pv !== '' && !prixValide(pv)) return notify("Prix d'achat invalide",'err');
  if(sv !== '' && !compteValide(sv)) return notify('Seuil invalide (nombre entier ≥ 0)','err');
  const data = { prixAchat: pv === '' ? null : Number(pv), seuil: sv === '' ? null : Number(sv), majLe: serverTimestamp(), majPar: user().name || '' };
  try{
    await setDoc(doc(db,'stk_articles',id), data, { merge:true });
    STK.reglArt.set(id, { ...(STK.reglArt.get(id)||{}), ...data });
    fermerModale('modal-article'); renderArticles(); notify('✅ Article réglé');
  }catch(e){ notify(msgErreur(e),'err'); }
};

/* ═══════════════════════════════════════════════════
   LIGNES DE SAISIE (entrées et transferts)
═══════════════════════════════════════════════════ */
function optionsArticles(){
  return '<option value="">— Article —</option>' + articlesTries().map(a=>`<option value="${esc(a._id)}">${esc(a.nom)}${a.ref ? ' ('+esc(a.ref)+')' : ''}</option>`).join('');
}
window.ajouterLigne = function(pref){
  const tb = document.getElementById(pref+'-lignes');
  if(tb.children.length >= MAX_LIGNES) return notify(`Maximum ${MAX_LIGNES} articles par opération`,'warn');
  const tr = document.createElement('tr');
  if(pref === 'en'){
    tr.innerHTML = `<td><select class="form-control l-art" onchange="majPrixLigne(this)">${optionsArticles()}</select></td>
      <td><input type="number" class="form-control l-qte" min="1" step="1" placeholder="Quantité" oninput="majTotalEntree()"></td>
      <td><input type="number" class="form-control l-prix" min="0" step="1" placeholder="Prix d'achat unitaire" oninput="majTotalEntree()"></td>
      <td class="num l-total">—</td><td><button class="btn btn-ghost btn-xs" onclick="this.closest('tr').remove();majTotalEntree()">✕</button></td>`;
  } else {
    tr.innerHTML = `<td><select class="form-control l-art" onchange="majLignesTransfert()">${optionsArticles()}</select></td>
      <td class="num l-dispo">—</td>
      <td><input type="number" class="form-control l-qte" min="1" step="1" placeholder="Quantité"></td>
      <td><button class="btn btn-ghost btn-xs" onclick="this.closest('tr').remove()">✕</button></td>`;
  }
  tb.appendChild(tr);
};
window.majPrixLigne = function(sel){
  const tr = sel.closest('tr'); const p = tr.querySelector('.l-prix');
  if(sel.value && p && p.value === '') { const v = prixAchat(sel.value).v; if(v) p.value = v; }
  majTotalEntree();
};
window.majTotalEntree = function(){
  let tot = 0;
  document.querySelectorAll('#en-lignes tr').forEach(tr => {
    const q = Number(tr.querySelector('.l-qte').value)||0, p = Number(tr.querySelector('.l-prix').value)||0;
    tr.querySelector('.l-total').textContent = q && p ? fmtF(q*p) : '—';
    tot += q*p;
  });
  document.getElementById('en-total').textContent = 'Total : ' + fmtF(tot);
};
window.majLignesTransfert = function(){
  const src = document.getElementById('tr-source').value;
  document.querySelectorAll('#tr-lignes tr').forEach(tr => {
    const a = tr.querySelector('.l-art').value;
    tr.querySelector('.l-dispo').textContent = src && a ? fmtN(qte(src, a)) : '—';
  });
};
function lireLignes(pref, avecPrix){
  const out = []; const vus = new Set();
  for(const tr of document.querySelectorAll('#'+pref+'-lignes tr')){
    const a = tr.querySelector('.l-art').value, q = tr.querySelector('.l-qte').value;
    const p = avecPrix ? tr.querySelector('.l-prix').value : null;
    if(!a && !q && (!avecPrix || !p)) continue;          // ligne vide : ignorée
    if(!a) throw new Error('Choisissez un article sur chaque ligne remplie');
    if(!IDX.articles.has(a)) throw new Error('Article inconnu');
    if(vus.has(a)) throw new Error(`« ${nomArt(a)} » apparaît deux fois : regroupez les quantités`);
    vus.add(a);
    if(!quantiteValide(q)) throw new Error(`Quantité invalide pour « ${nomArt(a)} » (nombre entier > 0)`);
    if(avecPrix && (p === '' || !prixValide(p))) throw new Error(`Prix d'achat invalide pour « ${nomArt(a)} »`);
    out.push({ articleId:a, qty:Number(q), prix: avecPrix ? Number(p) : null });
  }
  if(!out.length) throw new Error('Ajoutez au moins un article');
  return out;
}
function dateValide(d){ return /^\d{4}-\d{2}-\d{2}$/.test(d||'') && d <= aujourdhui(); }

/* ═══════════════════════════════════════════════════
   ENTRÉES FOURNISSEURS
   Écriture groupée (tout ou rien) : stock +qty, mouvement, prix d'achat.
═══════════════════════════════════════════════════ */
window.enregistrerEntree = () => avecVerrou('entree', 'btn-en', async () => {
  const ag = document.getElementById('en-agence').value, date = document.getElementById('en-date').value;
  const fourn = document.getElementById('en-fournisseur').value.trim(), ref = document.getElementById('en-ref').value.trim(), note = document.getElementById('en-note').value.trim();
  let lignes;
  try{
    if(!IDX.agences.has(ag)) throw new Error("Choisissez l'agence qui reçoit");
    if(!dateValide(date)) throw new Error('Date invalide (pas de date future)');
    if(!fourn) throw new Error('Indiquez le fournisseur');
    lignes = lireLignes('en', true);
  }catch(e){ return notify(e.message,'err'); }
  const total = lignes.reduce((s,l)=>s+l.qty*l.prix,0);
  if(!confirm(`Enregistrer l'entrée de ${lignes.length} article(s) à ${nomAg(ag)}, pour ${fmtF(total)} ?`)) return;
  const groupe = doc(collection(db,'stk_mouvements')).id;
  const b = writeBatch(db);
  for(const l of lignes){
    b.set(doc(db,'stk_stock',cleStock(ag,l.articleId)), { agenceId:ag, articleId:l.articleId, qty:increment(l.qty), majLe:serverTimestamp() }, { merge:true });
    b.set(doc(collection(db,'stk_mouvements')), { type:'entree', articleId:l.articleId, agenceId:ag, qty:l.qty, prixAchat:l.prix,
      fournisseur:fourn.slice(0,100), ref:ref.slice(0,60), note:note.slice(0,200), date, groupeId:groupe, ts:serverTimestamp(), ...auteur() });
    b.set(doc(db,'stk_articles',l.articleId), { prixAchat:l.prix, majLe:serverTimestamp(), majPar:user().name||'' }, { merge:true });
  }
  try{
    await b.commit();
    for(const l of lignes){
      STK.stock.set(cleStock(ag,l.articleId), qte(ag,l.articleId) + l.qty);
      STK.reglArt.set(l.articleId, { ...(STK.reglArt.get(l.articleId)||{}), prixAchat:l.prix });
    }
    document.getElementById('en-lignes').innerHTML = ''; ajouterLigne('en');
    ['en-fournisseur','en-ref','en-note'].forEach(id => document.getElementById(id).value = '');
    majTotalEntree(); chargerHistorique('entree','en-histo');
    notify('✅ Entrée enregistrée');
  }catch(e){ notify(msgErreur(e),'err'); }
});

/* ═══════════════════════════════════════════════════
   TRANSFERTS ENTRE AGENCES
═══════════════════════════════════════════════════ */
window.enregistrerTransfert = () => avecVerrou('transfert', 'btn-tr', async () => {
  const src = document.getElementById('tr-source').value, dst = document.getElementById('tr-dest').value;
  const date = document.getElementById('tr-date').value, note = document.getElementById('tr-note').value.trim();
  let lignes;
  try{
    if(!IDX.agences.has(src) || !IDX.agences.has(dst)) throw new Error("Choisissez l'agence de départ et l'agence d'arrivée");
    if(src === dst) throw new Error("L'agence d'arrivée doit être différente de l'agence de départ");
    if(!dateValide(date)) throw new Error('Date invalide (pas de date future)');
    lignes = lireLignes('tr', false);
    const manque = lignes.filter(l => l.qty > qte(src, l.articleId));
    if(manque.length) throw new Error('Stock insuffisant à ' + nomAg(src) + ' : ' + manque.map(l=>`${nomArt(l.articleId)} (dispo ${fmtN(qte(src,l.articleId))})`).join(', '));
  }catch(e){ return notify(e.message,'err'); }
  if(!confirm(`Transférer ${lignes.length} article(s) de ${nomAg(src)} vers ${nomAg(dst)} ?`)) return;
  const groupe = doc(collection(db,'stk_mouvements')).id;
  const b = writeBatch(db);
  for(const l of lignes){
    b.set(doc(db,'stk_stock',cleStock(src,l.articleId)), { agenceId:src, articleId:l.articleId, qty:increment(-l.qty), majLe:serverTimestamp() }, { merge:true });
    b.set(doc(db,'stk_stock',cleStock(dst,l.articleId)), { agenceId:dst, articleId:l.articleId, qty:increment(l.qty), majLe:serverTimestamp() }, { merge:true });
    b.set(doc(collection(db,'stk_mouvements')), { type:'transfert', articleId:l.articleId, agenceId:src, agenceDestId:dst, qty:l.qty,
      note:note.slice(0,200), date, groupeId:groupe, ts:serverTimestamp(), ...auteur() });
  }
  try{
    await b.commit();
    for(const l of lignes){
      STK.stock.set(cleStock(src,l.articleId), qte(src,l.articleId) - l.qty);
      STK.stock.set(cleStock(dst,l.articleId), qte(dst,l.articleId) + l.qty);
    }
    document.getElementById('tr-lignes').innerHTML = ''; ajouterLigne('tr');
    document.getElementById('tr-note').value = '';
    chargerHistorique('transfert','tr-histo');
    notify('✅ Transfert enregistré');
  }catch(e){ notify(msgErreur(e),'err'); }
});

// 30 derniers jours d'entrées ou de transferts, regroupés par opération.
async function chargerHistorique(type, cible){
  const el = document.getElementById(cible);
  el.innerHTML = '<div class="muted">Chargement…</div>';
  const d = new Date(); d.setDate(d.getDate()-30);
  const du = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  try{
    const snap = await getDocs(query(collection(db,'stk_mouvements'), where('date','>=',du)));
    const mv = _docs(snap).filter(m => m.type === type);
    const grp = new Map();
    for(const m of mv){ const k = m.groupeId || m._id; if(!grp.has(k)) grp.set(k, []); grp.get(k).push(m); }
    const ops = [...grp.values()].sort((a,b)=>String(b[0].date).localeCompare(String(a[0].date)) || ((b[0].ts?.seconds||0)-(a[0].ts?.seconds||0)));
    if(!ops.length){ el.innerHTML = '<div class="muted">Aucune opération ces 30 derniers jours.</div>'; return; }
    el.innerHTML = '<div class="tw"><table><thead><tr><th>Date</th><th>' + (type==='entree' ? 'Agence</th><th>Fournisseur</th><th>Réf.' : 'Départ</th><th>Arrivée</th><th>Note') + '</th><th>Articles</th>' + (type==='entree' ? '<th>Montant</th>' : '') + '<th>Par</th></tr></thead><tbody>' +
      ops.map(o => {
        const m = o[0];
        const det = o.map(x=>`${esc(nomArt(x.articleId))} × ${fmtN(x.qty)}`).join('<br>');
        const mt = o.reduce((s,x)=>s+(Number(x.qty)||0)*(Number(x.prixAchat)||0),0);
        return `<tr><td>${dateFr(m.date)}</td>` + (type==='entree'
          ? `<td>${esc(nomAg(m.agenceId))}</td><td>${esc(m.fournisseur||'')}</td><td>${esc(m.ref||'')}</td><td style="font-size:12px;">${det}</td><td>${fmtF(mt)}</td>`
          : `<td>${esc(nomAg(m.agenceId))}</td><td>${esc(nomAg(m.agenceDestId))}</td><td>${esc(m.note||'')}</td><td style="font-size:12px;">${det}</td>`) + `<td class="muted">${esc(m.auteurNom||'')}</td></tr>`;
      }).join('') + '</tbody></table></div>';
  }catch(e){ el.innerHTML = `<div class="alert alert-danger">${esc(msgErreur(e))}</div>`; }
}

/* ═══════════════════════════════════════════════════
   INVENTAIRES
   - un seul brouillon à la fois par agence ;
   - le premier inventaire validé d'une agence = inventaire de départ
     (case vide = 0) ; les suivants = périodiques (case vide = non compté) ;
   - à la validation, le stock devient la quantité comptée et l'écart
     (compté − théorique AU MOMENT DE LA VALIDATION) est journalisé ;
   - validation par paquets en transaction, reprise possible si coupure.
═══════════════════════════════════════════════════ */
let _inv = null;   // inventaire ouvert
window.renderInventaires = function(){
  document.getElementById('inv-liste').style.display = '';
  document.getElementById('inv-saisie').style.display = 'none';
  _inv = null;
  document.getElementById('inv-body').innerHTML = STK.inventaires.map(i => {
    const id = sid(i._id); const nb = Object.keys(i.comptes||{}).length;
    return `<tr><td>${dateFr(i.date)}</td><td>${esc(nomAg(i.agenceId))}</td>
      <td>${i.type==='depart' ? '<span class="tag tag-purple tag-sm">Départ</span>' : '<span class="tag tag-blue tag-sm">Périodique</span>'}</td>
      <td>${i.statut==='valide' ? '<span class="tag tag-green tag-sm">Validé</span>' : '<span class="tag tag-warn tag-sm">Brouillon</span>'}</td>
      <td>${fmtN(nb)}</td><td>${i.statut==='valide' ? fmtN(i.nbEcarts||0) : '—'}</td><td class="muted">${esc(i.validePar || i.creePar || '')}</td>
      <td class="no-print">${id ? `<button class="btn btn-ghost btn-xs" onclick="ouvrirInventaire('${id}')">${i.statut==='valide' ? '👁️ Voir' : '✏️ Continuer'}</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="emp">Aucun inventaire. Commencez par l\'inventaire de départ de chaque agence.</td></tr>';
};
window.nouvelInventaire = async function(){
  const ag = document.getElementById('inv-new-agence').value;
  if(!IDX.agences.has(ag)) return notify("Choisissez l'agence à inventorier",'err');
  if(STK.inventaires.some(i => i.agenceId === ag && i.statut !== 'valide')) return notify('Un brouillon existe déjà pour cette agence : continuez-le','warn');
  const type = STK.inventaires.some(i => i.agenceId === ag && i.statut === 'valide') ? 'periodique' : 'depart';
  if(!confirm(`Commencer l'inventaire ${type==='depart' ? 'de DÉPART' : 'périodique'} de ${nomAg(ag)} ?`)) return;
  const ref = doc(collection(db,'stk_inventaires'));
  const data = { agenceId:ag, type, date:aujourdhui(), statut:'brouillon', comptes:{}, articlesValides:[], creeLe:serverTimestamp(), creePar:user().name||'', creeParId:user().id||'' };
  try{
    await setDoc(ref, data);
    STK.inventaires.unshift({ ...data, _id:ref.id });
    ouvrirInventaire(ref.id);
  }catch(e){ notify(msgErreur(e),'err'); }
};
window.ouvrirInventaire = function(id){
  const i = STK.inventaires.find(x => x._id === id); if(!i) return;
  _inv = { ...i, comptes:{ ...(i.comptes||{}) } };
  document.getElementById('inv-liste').style.display = 'none';
  document.getElementById('inv-saisie').style.display = '';
  document.getElementById('inv-titre').textContent = `Inventaire ${i.type==='depart' ? 'de départ' : 'périodique'} — ${nomAg(i.agenceId)} — ${dateFr(i.date)}`;
  document.getElementById('inv-aide').innerHTML = i.statut === 'valide'
    ? `Inventaire validé par ${esc(i.validePar||'')}. Il ne peut plus être modifié.`
    : i.type === 'depart'
      ? "Saisissez la quantité <b>réellement comptée</b> de chaque article. <b>Case vide = 0</b> à la validation. Enregistrez le brouillon régulièrement si le comptage est long."
      : "Saisissez la quantité comptée des articles vérifiés. <b>Case vide = article non compté</b> (son stock ne change pas). L'écart est calculé au moment de la validation.";
  document.getElementById('inv-actions').style.display = i.statut === 'valide' ? 'none' : '';
  document.getElementById('inv-search').value = '';
  renderSaisieInventaire();
};
window.fermerInventaire = function(){ renderInventaires(); };
window.renderSaisieInventaire = function(){
  if(!_inv) return;
  const ro = _inv.statut === 'valide';
  const ecartsSeuls = document.getElementById('inv-ecarts').checked;
  const det = ro ? new Map((_inv.lignes||[]).map(l=>[l.articleId,l])) : null;
  let arts = filtreArticles(document.getElementById('inv-search').value);
  const rows = [];
  for(const a of arts){
    let theo, compte, ecart;
    if(ro){
      const l = det.get(a._id); if(!l) continue;
      theo = l.theorique; compte = l.compte; ecart = l.ecart;
    } else {
      theo = qte(_inv.agenceId, a._id);
      const v = _inv.comptes[a._id];
      compte = v; ecart = (v === '' || v == null) ? null : Number(v) - theo;
    }
    if(ecartsSeuls && !ecart) continue;
    const ec = ecart == null ? '<span class="muted">—</span>' : `<span class="${ecart>0?'ecart-pos':ecart<0?'ecart-neg':''}">${ecart>0?'+':''}${fmtN(ecart)}</span>`;
    const saisie = ro ? fmtN(compte) : `<input type="number" class="inv-input" min="0" step="1" value="${compte==null?'':esc(compte)}" data-art="${esc(a._id)}" oninput="saisirCompte(this)">`;
    rows.push(`<tr><td>${esc(a.nom)} <span class="muted">${esc(a.ref||'')}</span></td><td>${fmtN(theo)}</td><td>${saisie}</td><td class="inv-ec">${ec}</td></tr>`);
  }
  document.getElementById('inv-lignes').innerHTML = rows.join('') || '<tr><td colspan="4" class="emp">Aucun article.</td></tr>';
};
window.saisirCompte = function(inp){
  if(!_inv) return;
  const id = inp.dataset.art, v = inp.value.trim();
  if(v === '') delete _inv.comptes[id];
  else _inv.comptes[id] = v;
  const td = inp.closest('tr').querySelector('.inv-ec');
  if(v === ''){ td.innerHTML = '<span class="muted">—</span>'; return; }
  if(!compteValide(v)){ td.innerHTML = '<span class="ecart-neg">invalide</span>'; return; }
  const e = Number(v) - qte(_inv.agenceId, id);
  td.innerHTML = `<span class="${e>0?'ecart-pos':e<0?'ecart-neg':''}">${e>0?'+':''}${fmtN(e)}</span>`;
};
function comptesPropres(){
  const out = {};
  for(const [k,v] of Object.entries(_inv.comptes)){
    if(!IDX.articles.has(k)) continue;
    if(!compteValide(v)) throw new Error(`Quantité comptée invalide pour « ${nomArt(k)} »`);
    out[k] = Number(v);
  }
  return out;
}
window.enregistrerBrouillon = async function(){
  if(!_inv || _inv.statut === 'valide') return;
  let c; try{ c = comptesPropres(); }catch(e){ return notify(e.message,'err'); }
  try{
    await updateDoc(doc(db,'stk_inventaires',_inv._id), { comptes:c, majLe:serverTimestamp() });
    const i = STK.inventaires.find(x=>x._id===_inv._id); if(i) i.comptes = c;
    notify('💾 Brouillon enregistré');
  }catch(e){ notify(msgErreur(e),'err'); }
};
window.validerInventaire = () => avecVerrou('inventaire', 'btn-inv-valider', async () => {
  if(!_inv || _inv.statut === 'valide') return;
  let comptes; try{ comptes = comptesPropres(); }catch(e){ return notify(e.message,'err'); }
  const ag = _inv.agenceId, type = _inv.type;
  const deja = new Set(_inv.articlesValides || []);
  const ids = articlesTries().map(a=>a._id).filter(id => !deja.has(id));
  const prevu = calculInventaire(ids, comptes, id => qte(ag,id), type);
  if(!prevu.length && !deja.size) return notify('Aucun article compté','err');
  const vides = type === 'depart' ? ids.filter(id => !(id in comptes)).length : 0;
  const nbEc = prevu.filter(l=>l.ecart).length;
  if(!confirm(`Valider l'inventaire de ${nomAg(ag)} ?\n\n• ${prevu.length} article(s) pris en compte\n• ${nbEc} écart(s) corrigé(s)` + (vides ? `\n• ${vides} article(s) non saisi(s) mis à 0` : '') + '\n\nLe stock de l\'agence deviendra la quantité comptée. Cette action est définitive.')) return;
  try{
    // On enregistre d'abord les comptes, pour pouvoir reprendre si la validation est interrompue.
    await updateDoc(doc(db,'stk_inventaires',_inv._id), { comptes, statut:'validation_en_cours', majLe:serverTimestamp() });
    const invRef = doc(db,'stk_inventaires',_inv._id);
    const toutes = [...(_inv.lignes || [])];
    for(let k = 0; k < ids.length; k += INV_PAQUET){
      const paquet = ids.slice(k, k + INV_PAQUET);
      const faites = await runTransaction(db, async (tx) => {
        const inv = await tx.get(invRef);
        const dejaTx = new Set((inv.data() && inv.data().articlesValides) || []);
        const aFaire = paquet.filter(id => !dejaTx.has(id));
        const refs = aFaire.map(id => doc(db,'stk_stock',cleStock(ag,id)));
        const snaps = await Promise.all(refs.map(r => tx.get(r)));
        const actuel = new Map(aFaire.map((id,j) => [id, snaps[j].exists() ? (Number(snaps[j].data().qty)||0) : 0]));
        const lignes = calculInventaire(aFaire, comptes, id => actuel.get(id), type);
        for(const l of lignes){
          tx.set(doc(db,'stk_stock',cleStock(ag,l.articleId)), { agenceId:ag, articleId:l.articleId, qty:l.compte, majLe:serverTimestamp() }, { merge:true });
          if(l.ecart) tx.set(doc(collection(db,'stk_mouvements')), { type:'inventaire', articleId:l.articleId, agenceId:ag, qty:l.ecart,
            theorique:l.theorique, compte:l.compte, inventaireId:_inv._id, inventaireType:type, date:aujourdhui(), ts:serverTimestamp(), ...auteur() });
        }
        tx.update(invRef, { articlesValides:[...dejaTx, ...aFaire], lignes:[...((inv.data() && inv.data().lignes) || []), ...lignes] });
        return lignes;
      });
      for(const l of faites){ STK.stock.set(cleStock(ag,l.articleId), l.compte); toutes.push(l); }
    }
    const nbEcarts = toutes.filter(l=>l.ecart).length;
    const fin = { statut:'valide', nbEcarts, valideLe:serverTimestamp(), validePar:user().name||'', valideParId:user().id||'', date:aujourdhui() };
    await updateDoc(invRef, fin);
    const i = STK.inventaires.find(x=>x._id===_inv._id);
    if(i) Object.assign(i, fin, { comptes, lignes:toutes });
    notify(`✅ Inventaire validé — ${nbEcarts} écart(s) corrigé(s)`);
    renderInventaires();
  }catch(e){
    notify(msgErreur(e) + ' — relancez « Valider » : la validation reprendra là où elle s\'est arrêtée.','err');
    try{ await chargerTout(); }catch(_){}
  }
});

/* ═══════════════════════════════════════════════════
   LIVRAISONS TMMB → SORTIES DE STOCK
   Lues à l'ouverture de l'application (choix de l'utilisateur).
   - 1re lecture (ou jour J modifié) : livraisons datées ≥ jour J ;
   - ensuite : seulement les livraisons créées ou modifiées depuis la
     dernière lecture (champ _ts posé par TMMB à chaque écriture) ;
   - chaque livraison est déduite UNE SEULE FOIS : la fiche
     stk_livTraitees/{id de la livraison} est créée dans la même
     transaction que la sortie de stock. Deux appareils qui lisent en
     même temps ne peuvent donc pas déduire deux fois.
═══════════════════════════════════════════════════ */
const _clients = new Map();
async function _client(id){
  if(!id) return null;
  if(_clients.has(id)) return _clients.get(id);
  let c = null;
  try{ const s = await getDoc(doc(db,'clients',id)); c = s.exists() ? { ...s.data(), _id:s.id } : null; }catch(e){ c = null; }
  _clients.set(id, c);
  return c;
}
async function _produits(){
  if(IDX.produits) return IDX.produits;
  IDX.produits = new Map(_docs(await getDocs(collection(db,'produits'))).map(p=>[p._id,p]));
  return IDX.produits;
}

// Traite une livraison TMMB. Renvoie 'deduite' | 'a_verifier' | 'annulee' | 'rien'.
async function traiterLivraison(l){
  const livree = estLivree(l.statut);
  const produitsById = livree ? await _produits() : new Map();   // aussi pour le nom du produit
  const client = livree ? await _client(l.clientId) : null;
  const r = analyserLivraison(l, { jourJ:STK.jourJ, client, commerciauxById:IDX.commerciaux, produitsById, articlesById:IDX.articles });
  if(r.action === 'hors_periode') return 'rien';
  const fiche = doc(db,'stk_livTraitees',l._id);
  const infos = { livraisonId:l._id, date:l.date, produitId:l.produitId||'', produitNom:String(l.produitNom || (IDX.produits && IDX.produits.get(l.produitId)?.nom) || '').slice(0,120),
                  qtyLivraison:Number(l.qty)||0, clientId:l.clientId||'', statutTmmb:l.statut||'' };

  if(r.action === 'non_livree'){
    // Pas encore livrée : rien à faire. Déjà déduite puis repassée en « annulé » ou
    // « en attente » dans TMMB : on le signale, on ne remet rien en stock tout seul.
    return runTransaction(db, async (tx) => {
      const s = await tx.get(fiche);
      if(!s.exists() || s.data().statut !== 'deduit') return 'rien';
      tx.update(fiche, { statut:'annulee_apres_deduction', motif:`N'est plus « livrée » dans TMMB (statut : ${String(l.statut||'vide').slice(0,30)}) après la sortie de stock`, statutTmmb:l.statut||'', majLe:serverTimestamp() });
      return 'annulee';
    });
  }
  if(r.action === 'a_verifier'){
    return runTransaction(db, async (tx) => {
      const s = await tx.get(fiche);
      if(s.exists()) return 'rien';               // déjà traitée ou déjà signalée
      tx.set(fiche, { ...infos, statut:'a_verifier', motif:r.motif, agenceId:r.agenceId||'', traiteLe:serverTimestamp(), ...auteur() });
      return 'a_verifier';
    });
  }
  // r.action === 'deduire'
  return runTransaction(db, async (tx) => {
    const s = await tx.get(fiche);
    if(s.exists() && s.data().statut !== 'a_verifier') return 'rien';   // déjà déduite, ignorée ou réintégrée
    for(const x of r.lignes){
      tx.set(doc(db,'stk_stock',cleStock(r.agenceId,x.articleId)), { agenceId:r.agenceId, articleId:x.articleId, qty:increment(-x.qty), majLe:serverTimestamp() }, { merge:true });
      tx.set(doc(collection(db,'stk_mouvements')), { type:'livraison', articleId:x.articleId, agenceId:r.agenceId, qty:-x.qty,
        livraisonId:l._id, produitNom:infos.produitNom, date:l.date, ts:serverTimestamp(), ...auteur() });
    }
    tx.set(fiche, { ...infos, statut:'deduit', agenceId:r.agenceId, lignes:r.lignes, motif:'', traiteLe:serverTimestamp(), ...auteur() });
    return 'deduite';
  }).then(res => {
    if(res === 'deduite') for(const x of r.lignes) STK.stock.set(cleStock(r.agenceId,x.articleId), qte(r.agenceId,x.articleId) - x.qty);
    return res;
  });
}

window.relireLivraisons = async function(manuel){
  if(_livEnCours) return;
  if(!STK.jourJ){
    STK.derniereLecture = null;
    if(manuel) notify('Définissez d\'abord le jour J (Réglages)','warn');
    renderPg(curPg); return;
  }
  _livEnCours = true;
  const btn = document.getElementById('btn-relire-liv');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Lecture…'; }
  const res = { lues:0, deduites:0, aVerifier:0, annulees:0, erreur:'' };
  try{
    const c = STK.curseur;
    const reprendre = !c || c.jourJ !== STK.jourJ || !c.ms;
    // 2 min de marge : un document écrit pendant la lecture précédente est relu (sans risque de doublon).
    const snap = reprendre
      ? await getDocs(query(collection(db,'livraisons'), where('date','>=',STK.jourJ)))
      : await getDocs(query(collection(db,'livraisons'), where('_ts','>', Timestamp.fromMillis(c.ms - 120000))));
    const livs = _docs(snap).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    res.lues = livs.length;
    let maxMs = 0;
    for(const l of livs){
      const ts = l._ts && typeof l._ts.toMillis === 'function' ? l._ts.toMillis() : 0;
      if(ts > maxMs) maxMs = ts;
      try{
        const r = await traiterLivraison(l);
        if(r === 'deduite') res.deduites++;
        else if(r === 'a_verifier') res.aVerifier++;
        else if(r === 'annulee') res.annulees++;
      }catch(e){
        res.erreur = msgErreur(e);
        console.warn('[livraisons]', l._id, e);
        break;
      }
    }
    // Le curseur n'avance QUE si toute la lecture a réussi : en cas d'échec, la même
    // période est relue la prochaine fois (sans doublon, grâce à stk_livTraitees).
    // Il prend l'heure du SERVEUR (_ts des livraisons), jamais l'horloge du téléphone.
    if(!res.erreur && maxMs && (!c || reprendre || maxMs > c.ms)){
      const cur = { ms:maxMs, jourJ:STK.jourJ, majLe:serverTimestamp() };
      await setDoc(doc(db,'stk_config','curseurLivraisons'), cur);
      STK.curseur = { ...cur, majLe:null };
    }
    const aver = await getDocs(query(collection(db,'stk_livTraitees'), where('statut','in',['a_verifier','annulee_apres_deduction'])));
    STK.aVerifier = _docs(aver).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  }catch(e){
    res.erreur = msgErreur(e);
    setSync(false, 'Erreur de lecture');
  }finally{
    _livEnCours = false;
    if(btn){ btn.disabled = false; btn.textContent = '🔄 Relire les livraisons'; }
  }
  const n = new Date();
  STK.derniereLecture = { ...res, heure: String(n.getHours()).padStart(2,'0') + ':' + String(n.getMinutes()).padStart(2,'0') };
  majBandeau();
  if(res.erreur) notify('Livraisons : ' + res.erreur,'err');
  else if(manuel || res.deduites || res.aVerifier || res.annulees)
    notify(`🚚 ${res.deduites} livraison(s) déduite(s)` + (res.aVerifier ? `, ${res.aVerifier} à vérifier` : '') + (res.annulees ? `, ${res.annulees} annulée(s) après sortie` : ''), res.aVerifier || res.annulees ? 'warn' : 'ok');
  if(['dashboard','livraisons','stock'].includes(curPg)) renderPg(curPg);
};

function renderAVerifier(){
  document.getElementById('liv-info').innerHTML = STK.jourJ
    ? `Les livraisons TMMB <b>datées du ${dateFr(STK.jourJ)} ou après</b> et marquées « livrées » sortent du stock de l'agence du client, une seule fois chacune, à l'ouverture de l'application.`
    : `Le <b>jour J</b> n'est pas défini : aucune livraison n'est déduite. ${estAdmin() ? 'Définissez-le dans Réglages.' : "Demandez à l'administrateur."}`;
  const card = document.getElementById('liv-averifier-card');
  card.style.display = STK.aVerifier.length ? '' : 'none';
  document.getElementById('liv-averifier').innerHTML = STK.aVerifier.map(f => {
    const id = sid(f._id);
    const actions = !id ? '' : f.statut === 'annulee_apres_deduction'
      ? `<button class="btn btn-success btn-xs" onclick="reintegrerLivraison('${id}')">↩ Remettre en stock</button> <button class="btn btn-ghost btn-xs" onclick="ignorerLivraison('${id}')">Garder la sortie</button>`
      : `<button class="btn btn-primary btn-xs" onclick="reessayerLivraison('${id}')">🔄 Réessayer</button> <button class="btn btn-ghost btn-xs" onclick="ignorerLivraison('${id}')">Ignorer</button>`;
    return `<tr><td>${dateFr(f.date)}</td><td>${esc(f.produitNom||f.produitId||'')}</td><td>${fmtN(f.qtyLivraison)}</td><td style="font-size:12px;">${esc(f.motif||'')}</td><td class="no-print">${actions}</td></tr>`;
  }).join('');
}
window.chargerLivTraitees = async function(){
  const du = document.getElementById('liv-du').value, au = document.getElementById('liv-au').value;
  const tb = document.getElementById('liv-body');
  tb.innerHTML = '<tr><td colspan="6" class="emp">Chargement…</td></tr>';
  try{
    const snap = await getDocs(query(collection(db,'stk_livTraitees'), where('date','>=',du||'0000'), where('date','<=',au||'9999')));
    const rows = _docs(snap).filter(f => ['deduit','reintegree'].includes(f.statut)).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    tb.innerHTML = rows.map(f => `<tr><td>${dateFr(f.date)}</td><td>${esc(f.produitNom||'')}${f.statut==='reintegree' ? ' <span class="tag tag-warn tag-sm">réintégrée</span>' : ''}</td><td>${fmtN(f.qtyLivraison)}</td><td>${esc(nomAg(f.agenceId))}</td>
      <td style="font-size:12px;">${(f.lignes||[]).map(x=>`${esc(nomArt(x.articleId))} × ${fmtN(x.qty)}`).join('<br>')}</td>
      <td class="muted">${f.traiteLe && f.traiteLe.toDate ? f.traiteLe.toDate().toLocaleString('fr-FR') : ''}</td></tr>`).join('')
      || '<tr><td colspan="6" class="emp">Aucune livraison déduite sur cette période.</td></tr>';
  }catch(e){ tb.innerHTML = `<tr><td colspan="6" class="emp">${esc(msgErreur(e))}</td></tr>`; }
};
window.reessayerLivraison = (id) => avecVerrou('liv:'+id, null, async () => {
  try{
    const s = await getDoc(doc(db,'livraisons',id));
    if(!s.exists()) return notify('Livraison introuvable dans TMMB','err');
    _clients.delete(s.data().clientId); IDX.produits = null;   // relire la fiche client et les produits, peut-être corrigés
    // Les articles ou les commerciaux ont pu être corrigés dans TMMB entre-temps.
    await chargerTout();
    const r = await traiterLivraison({ ...s.data(), _id:s.id });
    await syncApresAction();
    notify(r === 'deduite' ? '✅ Livraison déduite du stock' : 'Toujours impossible à déduire : vérifiez le motif', r === 'deduite' ? 'ok' : 'warn');
  }catch(e){ notify(msgErreur(e),'err'); }
});
window.ignorerLivraison = (id) => avecVerrou('liv:'+id, null, async () => {
  const f = STK.aVerifier.find(x=>x._id===id); if(!f) return;
  const msg = f.statut === 'annulee_apres_deduction'
    ? 'Garder la sortie de stock malgré l\'annulation dans TMMB ?'
    : 'Ignorer cette livraison ? Elle ne sera jamais déduite du stock.';
  if(!confirm(msg)) return;
  try{
    await updateDoc(doc(db,'stk_livTraitees',id), { statut: f.statut === 'annulee_apres_deduction' ? 'deduit' : 'ignoree', motif: (f.motif||'') + ' — décision : ' + (user().name||''), majLe:serverTimestamp() });
    await syncApresAction(); notify('✅ Enregistré');
  }catch(e){ notify(msgErreur(e),'err'); }
});
window.reintegrerLivraison = (id) => avecVerrou('liv:'+id, null, async () => {
  if(!confirm('Remettre en stock les articles de cette livraison annulée ?')) return;
  const fiche = doc(db,'stk_livTraitees',id);
  try{
    const lignes = await runTransaction(db, async (tx) => {
      const s = await tx.get(fiche);
      if(!s.exists() || s.data().statut !== 'annulee_apres_deduction') return null;
      const f = s.data();
      for(const x of (f.lignes||[])){
        tx.set(doc(db,'stk_stock',cleStock(f.agenceId,x.articleId)), { agenceId:f.agenceId, articleId:x.articleId, qty:increment(x.qty), majLe:serverTimestamp() }, { merge:true });
        tx.set(doc(collection(db,'stk_mouvements')), { type:'reintegration', articleId:x.articleId, agenceId:f.agenceId, qty:x.qty, livraisonId:id, date:aujourdhui(), ts:serverTimestamp(), ...auteur() });
      }
      tx.update(fiche, { statut:'reintegree', majLe:serverTimestamp() });
      return f.lignes || [];
    });
    if(lignes === null) return notify('Déjà traitée','warn');
    await syncApresAction(); notify('✅ Articles remis en stock');
  }catch(e){ notify(msgErreur(e),'err'); }
});
async function syncApresAction(){
  await chargerTout(); majBandeau(); renderPg(curPg);
}

/* ═══════════════════════════════════════════════════
   MOUVEMENTS & RAPPORTS
═══════════════════════════════════════════════════ */
let _mv = [];
const TYPES = { entree:'Entrée', transfert:'Transfert', livraison:'Livraison TMMB', inventaire:'Écart inventaire', reintegration:'Réintégration' };
window.chargerMouvements = async function(){
  const du = document.getElementById('mv-du').value, au = document.getElementById('mv-au').value;
  if(!du || !au || du > au) return notify('Période invalide','err');
  document.getElementById('mv-body').innerHTML = '<tr><td colspan="8" class="emp">Chargement…</td></tr>';
  try{
    const snap = await getDocs(query(collection(db,'stk_mouvements'), where('date','>=',du), where('date','<=',au)));
    _mv = _docs(snap).sort((a,b)=>String(b.date).localeCompare(String(a.date)) || ((b.ts?.seconds||0)-(a.ts?.seconds||0)));
    renderMouvements();
  }catch(e){ document.getElementById('mv-body').innerHTML = `<tr><td colspan="8" class="emp">${esc(msgErreur(e))}</td></tr>`; }
};
function mouvementsFiltres(){
  const ag = document.getElementById('mv-agence').value, ty = document.getElementById('mv-type').value;
  return _mv.filter(m => (!ty || m.type === ty) && (!ag || m.agenceId === ag || m.agenceDestId === ag));
}
function renderMouvements(){
  const ag = document.getElementById('mv-agence').value;
  const mv = mouvementsFiltres();
  document.getElementById('mv-count').textContent = '(' + mv.length + ')';
  document.getElementById('mv-body').innerHTML = mv.slice(0,1000).map(m => {
    let qtxt = fmtN(m.qty), det = '';
    if(m.type === 'transfert'){ det = `${esc(nomAg(m.agenceId))} → ${esc(nomAg(m.agenceDestId))}`; if(ag) qtxt = (m.agenceId === ag ? '-' : '+') + fmtN(m.qty); }
    else if(m.type === 'entree') det = esc(m.fournisseur||'') + (m.ref ? ' · ' + esc(m.ref) : '');
    else if(m.type === 'livraison') det = esc(m.produitNom||'');
    else if(m.type === 'inventaire') det = (m.inventaireType === 'depart' ? 'Inventaire de départ · ' : '') + `théorique ${fmtN(m.theorique)} → compté ${fmtN(m.compte)}`;
    return `<tr><td>${dateFr(m.date)}</td><td>${esc(TYPES[m.type]||m.type)}</td><td>${esc(nomArt(m.articleId))}</td><td>${esc(m.type==='transfert' ? '' : nomAg(m.agenceId))}</td>
      <td class="${Number(m.qty)<0 || qtxt.startsWith('-') ? 'ecart-neg' : ''}">${qtxt}</td><td>${m.prixAchat != null ? fmtF(m.prixAchat) : ''}</td><td style="font-size:12px;">${det}${m.note ? ' · ' + esc(m.note) : ''}</td><td class="muted">${esc(m.auteurNom||'')}</td></tr>`;
  }).join('') + (mv.length > 1000 ? `<tr><td colspan="8" class="emp">1000 premiers affichés sur ${mv.length} — exportez en CSV pour tout voir.</td></tr>` : '') || '<tr><td colspan="8" class="emp">Aucun mouvement sur cette période.</td></tr>';

  const syn = syntheseMouvements(mv, ag);
  let tE=0, tL=0, tI=0, vE=0;
  document.getElementById('mv-synthese').innerHTML = articlesTries().filter(a => syn.has(a._id)).map(a => {
    const r = syn.get(a._id);
    const st = ag ? qte(ag, a._id) : stockTotal(a._id);
    tE += r.entrees; tL += r.livraisons; tI += r.inventaire; vE += r.valeurEntrees;
    return `<tr><td>${esc(a.nom)}</td><td>${r.depart ? fmtN(r.depart) : '—'}</td><td>${fmtN(r.entrees)}</td><td>${ag ? fmtN(r.recus) : '—'}</td><td>${ag ? fmtN(r.envoyes) : '—'}</td><td>${fmtN(r.livraisons)}</td>
      <td class="${r.inventaire>0?'ecart-pos':r.inventaire<0?'ecart-neg':''}">${r.inventaire>0?'+':''}${fmtN(r.inventaire)}</td><td style="font-weight:700;">${r.variation>0?'+':''}${fmtN(r.variation)}</td><td>${fmtN(st)}</td><td>${fmtF(Math.max(0,st)*prixAchat(a._id).v)}</td></tr>`;
  }).join('') || '<tr><td colspan="10" class="emp">Aucun mouvement.</td></tr>';
  document.getElementById('mv-kpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-lbl">Unités entrées</div><div class="kpi-val kv-green">${fmtN(tE)}</div><div class="kpi-sub">${fmtF(vE)} d'achats</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Unités livrées</div><div class="kpi-val kv-blue">${fmtN(tL)}</div><div class="kpi-sub">livraisons TMMB</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Écarts d'inventaire</div><div class="kpi-val ${tI<0?'kv-red':'kv-green'}">${tI>0?'+':''}${fmtN(tI)}</div><div class="kpi-sub">unités (hors inventaire de départ)</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Mouvements</div><div class="kpi-val kv-purple">${fmtN(mv.length)}</div><div class="kpi-sub">sur la période</div></div>`;
}
['mv-agence','mv-type'].forEach(id => document.getElementById(id).addEventListener('change', ()=>{ if(_mv.length || curPg==='mouvements') renderMouvements(); }));
window.exportMouvementsCsv = function(){
  const rows = [['Date','Type','Référence article','Article','Agence','Agence arrivée','Quantité',"Prix d'achat",'Fournisseur','N° facture','Produit livré','Théorique','Compté','Note','Par']];
  for(const m of mouvementsFiltres()){
    const a = IDX.articles.get(m.articleId) || {};
    rows.push([m.date, TYPES[m.type]||m.type, a.ref||'', a.nom||m.articleId, nomAg(m.agenceId), m.agenceDestId ? nomAg(m.agenceDestId) : '', m.qty, m.prixAchat ?? '', m.fournisseur||'', m.ref||'', m.produitNom||'', m.theorique ?? '', m.compte ?? '', m.note||'', m.auteurNom||'']);
  }
  telechargerCsv('mouvements_' + document.getElementById('mv-du').value + '_' + document.getElementById('mv-au').value + '.csv', rows);
};

/* ═══════════════════════════════════════════════════
   RÉGLAGES (administrateur)
═══════════════════════════════════════════════════ */
window.enregistrerJourJ = async function(){
  if(!estAdmin()) return notify("Réservé à l'administrateur",'err');
  const d = document.getElementById('rg-jourj').value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return notify('Date invalide','err');
  if(STK.jourJ && d === STK.jourJ) return notify('Aucun changement','warn');
  const msg = STK.jourJ
    ? `Changer le jour J du ${dateFr(STK.jourJ)} au ${dateFr(d)} ?\n\nLes livraisons déjà déduites restent déduites.`
    : `Fixer le jour J au ${dateFr(d)} ?\n\nToutes les livraisons TMMB livrées datées de ce jour ou après seront déduites du stock.`;
  if(!confirm(msg)) return;
  try{
    await setDoc(doc(db,'stk_config','reglages'), { jourJ:d, majLe:serverTimestamp(), majPar:user().name||'' }, { merge:true });
    STK.jourJ = d; majBandeau(); notify('✅ Jour J enregistré');
    relireLivraisons(true);
  }catch(e){ notify(msgErreur(e),'err'); }
};
