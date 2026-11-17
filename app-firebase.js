/* ═══════════════════════════════════════════════════
   TRIOMPHANT — STOCK · Firebase et logique de l'application (v3)
   ---------------------------------------------------
   Même projet Firebase que TMMB (triomphant-v2), mêmes comptes.

   DONNÉES TMMB — LECTURE SEULE, JAMAIS MODIFIÉES :
     articles, agences, commerciaux, produits, livraisons, clients
   DONNÉES DU STOCK — collections propres :
     stk_stock            un document par couple lieu/article : { agenceId, articleId, qty }
                          (lieu = une agence TMMB ou le stock général « STOCK_GENERAL »)
     stk_articles         seuil d'alerte par article
     stk_mouvements       journal de tous les mouvements (SANS aucun prix)
     stk_prixEntrees      prix d'achat de chaque ligne d'entrée — ADMIN SEULEMENT
     stk_inventaires      inventaires (brouillon puis validé)
     stk_rapportsInventaire  rapports d'inventaire numérotés (quantités)
     stk_rapportsValeurs  valorisation des rapports — ADMIN SEULEMENT
     stk_livTraitees      une fiche par livraison TMMB traitée (pas de doublon)
     stk_config           reglages (jour J) · curseurLivraisons · compteurs

   CONFIDENTIALITÉ DES PRIX
     Le gestionnaire de stock ne voit aucun prix ni aucune valeur dans
     l'application. Les prix et montants du module stock sont dans des
     collections que les règles Firestore réservent à l'administrateur.
     ⚠️ Le prix d'achat « pa » des articles TMMB reste lisible par le
     gestionnaire dans la base TMMB elle-même (règles de TMMB, inchangées).
═══════════════════════════════════════════════════ */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, getDocs, getDoc, doc, setDoc, updateDoc, query, where, limit,
         serverTimestamp, Timestamp, increment, writeBatch, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { GENERAL, MOTIFS_SORTIE, TYPES_CORRIGEABLES, cleStock, analyserLivraison, syntheseMouvements, calculInventaire,
         deltasCorrection, deltasAnnulation, qteAffichee, totauxRapport, numeroRapport,
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
const MAX_LIGNES = 120;          // lignes par opération (limite d'écriture groupée Firestore : 500)
const INV_PAQUET = 120;          // validation d'inventaire par paquets
const PAS = 25;                  // lignes affichées avant « Afficher plus »

const _fbApp = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
const db = getFirestore(_fbApp);
const auth = getAuth(_fbApp);

/* ═══════════════════════════════════════════════════
   ÉTAT
═══════════════════════════════════════════════════ */
const TDB = { articles:[], agences:[], commerciaux:[] };
const IDX = { articles:new Map(), agences:new Map(), commerciaux:new Map(), produits:null };
const STK = {
  stock: new Map(),        // cleStock(lieu, article) → qty
  reglArt: new Map(),      // articleId → { seuil }
  jourJ: '', curseur: null,
  inventaires: [], aVerifier: [], derniereLecture: null
};
let curPg = 'dashboard';
let _bootEnCours = false, _appDemarree = false, _livEnCours = false;
const _verrous = new Set();

const PAGE_TITLES = {
  dashboard:"Vue d'ensemble", general:'État du stock général', entrees:'Entrées fournisseurs', dispatch:'Dispatch vers les agences',
  sorties:'Autres sorties', agences:'Stock par agence', transferts:'Transferts entre lieux', livraisons:'Livraisons TMMB',
  inventaires:'Inventaires', rapports:"Rapports d'inventaire", mouvements:'Mouvements & synthèse', articles:'Articles',
  valeurs:'Achats & valeurs', reglages:'Réglages'
};
const PAGES_ADMIN = ['valeurs','reglages'];

const user = () => getCurrentUser() || {};
const estAdmin = () => user().role === 'admin';
const auteur = () => ({ auteurId: user().id || '', auteurNom: user().name || '' });
const nomArt = id => (IDX.articles.get(id) || {}).nom || '(article supprimé dans TMMB)';
const nomLieu = id => id === GENERAL ? 'Stock général' : ((IDX.agences.get(id) || {}).nom || '(agence inconnue)');
const lieuHtml = id => id === GENERAL ? '<span class="lieu-general">🏭 Stock général</span>' : esc(nomLieu(id));
const estLieu = id => id === GENERAL || IDX.agences.has(id);
const qte = (lieu, art) => STK.stock.get(cleStock(lieu, art)) || 0;
const articlesTries = () => [...TDB.articles].sort((a,b)=>String(a.nom||'').localeCompare(String(b.nom||''),'fr'));
const agencesTriees = () => [...TDB.agences].sort((a,b)=>String(a.nom||'').localeCompare(String(b.nom||''),'fr'));
const lieux = () => [{ _id:GENERAL, nom:'Stock général' }, ...agencesTriees()];
const refTag = a => a && a.ref ? `<span class="ref-tag">${esc(a.ref)}</span>` : '';
// Prix d'achat TMMB actuel — utilisé UNIQUEMENT dans les vues administrateur.
const prixTmmb = id => Number((IDX.articles.get(id) || {}).pa) || 0;
function seuil(id){
  const r = STK.reglArt.get(id);
  if(r && r.seuil != null && r.seuil !== '') return Number(r.seuil) || 0;
  return Number((IDX.articles.get(id) || {}).stockMin) || 0;
}
const stockAgences = art => TDB.agences.reduce((s,a)=>s+qte(a._id, art), 0);
const stockTotal = art => qte(GENERAL, art) + stockAgences(art);
function _ilYa(jours){ const d = new Date(); d.setDate(d.getDate()-jours); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
const _docs = snap => snap.docs.map(d => ({ ...d.data(), _id:d.id }));

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
  if(s.includes('permission')) return "Accès refusé par Firebase (droits insuffisants, ou règles stk_ non publiées : voir REGLES-FIRESTORE-stock.txt).";
  if(s.includes('unavailable') || s.includes('network') || s.includes('offline')) return "Pas de connexion internet : rien n'a été enregistré, réessayez.";
  return (e && e.message) ? e.message : 'Erreur : ' + s;
}
function setSync(ok, txt){
  const d = document.getElementById('sync-dot'); const l = document.getElementById('sync-label');
  if(d) d.style.background = ok ? 'var(--accent2)' : 'var(--danger)';
  if(l) l.textContent = txt || (ok ? 'Connecté' : 'Hors ligne');
}

/* ─── Listes longues : on affiche 25 lignes, puis « Afficher plus » ─── */
const _pages = new Map();
function paginer(tbodyId, rows, colspan, vide){
  const prev = _pages.get(tbodyId);
  _pages.set(tbodyId, { rows, colspan, vide, n: PAS });
  dessinerPage(tbodyId);
}
function dessinerPage(id){
  const p = _pages.get(id); const tb = document.getElementById(id); if(!p || !tb) return;
  if(!p.rows.length){ tb.innerHTML = `<tr><td colspan="${p.colspan}" class="emp">${p.vide}</td></tr>`; return; }
  const reste = p.rows.length - p.n;
  tb.innerHTML = p.rows.slice(0, p.n).join('') + (reste > 0
    ? `<tr class="ligne-plus no-print"><td colspan="${p.colspan}"><span class="muted">${fmtN(p.n)} sur ${fmtN(p.rows.length)} affichés</span>
       <button class="btn btn-ghost btn-xs" onclick="pagePlus('${id}')">Afficher ${Math.min(PAS, reste)} de plus</button>
       <button class="btn btn-ghost btn-xs" onclick="pageTout('${id}')">Tout afficher</button></td></tr>` : '');
}
window.pagePlus = id => { const p = _pages.get(id); if(p){ p.n += PAS; dessinerPage(id); } };
window.pageTout = id => { const p = _pages.get(id); if(p){ p.n = p.rows.length; dessinerPage(id); } };

/* ─── Menu : groupes repliables (état mémorisé sur cet appareil) ─── */
function _groupesFermes(){ try{ return JSON.parse(localStorage.getItem('stk_menu_fermes') || '[]'); }catch(e){ return []; } }
window.basculerGroupe = function(el){
  const g = el.closest('.nav-group'); g.classList.toggle('ferme');
  const f = [...document.querySelectorAll('.nav-group.ferme')].map(x => x.dataset.groupe);
  try{ localStorage.setItem('stk_menu_fermes', JSON.stringify(f)); }catch(e){}
};
function appliquerMenu(){
  const f = _groupesFermes();
  document.querySelectorAll('.nav-group').forEach(g => g.classList.toggle('ferme', f.includes(g.dataset.groupe)));
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
   À chaque ouverture : articles + agences + commerciaux (TMMB)
   + stk_stock + stk_articles + inventaires + livraisons à vérifier.
   Les mouvements, prix et rapports ne sont lus qu'à la demande, par période.
═══════════════════════════════════════════════════ */
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
  TDB.agences = _docs(ags).filter(a => a._id !== GENERAL);
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
  document.body.classList.toggle('role-admin', estAdmin());
  document.getElementById('user-avatar').textContent = String(u.name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
  document.getElementById('user-badge-name').textContent = (u.name||'') + (estAdmin() ? ' 🛡️' : ' 📦');
  appliquerMenu();
  construireOperations();
  remplirSelects();
  const t = aujourdhui(), m30 = _ilYa(30);
  const defaut = (id, v) => { const el = document.getElementById(id); if(el && !el.value) el.value = v; };
  defaut('mv-du', t.slice(0,8) + '01'); defaut('mv-au', t);
  defaut('va-du', t.slice(0,8) + '01'); defaut('va-au', t);
  defaut('liv-du', m30); defaut('liv-au', t);
  defaut('rap-du', _ilYa(365)); defaut('rap-au', t);
  majBandeau();
  go(curPg);
}

function majBandeau(){
  document.getElementById('topbar-jourj').textContent = 'Jour J : ' + (STK.jourJ ? dateFr(STK.jourJ) : 'non défini');
  const b = document.getElementById('badge-averifier');
  if(b){ b.textContent = STK.aVerifier.length; b.style.display = STK.aVerifier.length ? '' : 'none'; }
}

// Remplit toutes les listes déroulantes de filtres (catégories, lieux, agences).
function remplirSelects(){
  const optsAg = agencesTriees().map(a=>`<option value="${esc(a._id)}">${esc(a.nom||a._id)}${a.ville ? ' — '+esc(a.ville) : ''}</option>`).join('');
  const optGen = `<option value="${GENERAL}">🏭 Stock général</option>`;
  const cats = [...new Set(TDB.articles.map(a => a.cat).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),'fr'));
  const optsCat = '<option value="">Toutes les catégories</option>' + cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const garder = (el, html) => { const v = el.value; el.innerHTML = html; if(v && [...el.options].some(o=>o.value===v)) el.value = v; };
  document.querySelectorAll('.f-cat').forEach(el => garder(el, optsCat));
  document.querySelectorAll('.f-lieu').forEach(el => garder(el, '<option value="">Tous les lieux</option>' + optGen + optsAg));
  document.querySelectorAll('.f-agence').forEach(el => garder(el, '<option value="">Toutes les agences</option>' + optsAg));
  garder(document.getElementById('ag-agence'), '<option value="">Toutes les agences</option>' + optsAg);
  // Inventaire : l'admin peut inventorier le stock général, le gestionnaire seulement les agences.
  garder(document.getElementById('inv-new-lieu'), '<option value="">— Lieu à inventorier —</option>' + (estAdmin() ? optGen : '') + optsAg);
  remplirSelectsOperations(optsAg, optGen);
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
  if(PAGES_ADMIN.includes(pg) && !estAdmin()) pg = 'dashboard';
  curPg = pg;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.querySelectorAll('.nav-group').forEach(g=>g.classList.remove('contient-actif'));
  const p = document.getElementById('page-'+pg); if(p) p.classList.add('active');
  const n = document.getElementById('nav-'+pg);
  if(n){ n.classList.add('active'); const g = n.closest('.nav-group'); if(g) g.classList.add('contient-actif'); }
  document.getElementById('topbar-title').textContent = PAGE_TITLES[pg] || pg;
  renderPg(pg);
  if(window.innerWidth <= 860) toggleMobileSidebar(false);
  const c = document.getElementById('content'); if(c) c.scrollTop = 0;
};
function renderPg(pg){
  try{
    if(pg==='dashboard') renderDashboard();
    else if(pg==='general') renderGeneral();
    else if(pg==='agences') renderAgences();
    else if(pg==='articles') renderArticles();
    else if(['entrees','dispatch','sorties','transferts'].includes(pg)){ const op = PAGE_OP[pg]; majLignes(op); chargerHistorique(op); }
    else if(pg==='inventaires') renderInventaires();
    else if(pg==='rapports'){ fermerRapport(); chargerRapports(); }
    else if(pg==='livraisons'){ renderAVerifier(); chargerLivTraitees(); }
    else if(pg==='mouvements') chargerMouvements();
    else if(pg==='valeurs') chargerValeurs();
    else if(pg==='reglages') document.getElementById('rg-jourj').value = STK.jourJ || '';
  }catch(e){ console.error(e); notify("Erreur d'affichage : " + e.message,'err'); }
}

/* ═══════════════════════════════════════════════════
   FILTRES COMMUNS SUR LES ARTICLES
═══════════════════════════════════════════════════ */
function filtrerArticles(txt, cat){
  const t = String(txt||'').trim().toLowerCase();
  return articlesTries().filter(a => (!cat || a.cat === cat) &&
    (!t || String(a.nom||'').toLowerCase().includes(t) || String(a.ref||'').toLowerCase().includes(t)));
}
function etatOk(etat, q, s){
  if(etat === 'stock') return q > 0;
  if(etat === 'bas') return s > 0 && q < s;
  if(etat === 'zero') return q === 0;
  if(etat === 'neg') return q < 0;
  return true;
}
const clsQte = (q, s) => q < 0 ? 'qte-neg' : (s > 0 && q < s ? 'qte-bas' : '');

/* ═══════════════════════════════════════════════════
   VUE D'ENSEMBLE
═══════════════════════════════════════════════════ */
function lignesStockBas(){
  const out = [];
  for(const l of lieux()) for(const a of TDB.articles){
    const s = seuil(a._id); if(!(s > 0)) continue;
    const q = qte(l._id, a._id);
    if(q < s) out.push({ l, a, q, s });
  }
  return out.sort((x,y)=>(x.q - x.s) - (y.q - y.s));
}
async function renderDashboard(){
  const admin = estAdmin();
  const sansDepart = lieux().filter(l => !STK.inventaires.some(i => i.agenceId === l._id && i.statut === 'valide'));
  let html = '';
  if(!STK.jourJ) html += `<div class="alert alert-warn">📅 Le <b>jour J</b> n'est pas défini : les livraisons TMMB ne sont pas encore déduites du stock. ${admin ? '<a href="#" onclick="go(\'reglages\');return false;">Le définir</a>' : "Demandez à l'administrateur de le définir."}</div>`;
  if(sansDepart.length) html += `<div class="alert alert-info">📋 ${sansDepart.length} lieu(x) sans inventaire de départ : ${sansDepart.map(l=>esc(l.nom)).join(', ')}. <a href="#" onclick="go('inventaires');return false;">Faire l'inventaire</a></div>`;
  document.getElementById('dash-alerte-config').innerHTML = html;

  let uGen = 0, uAg = 0, vGen = 0, vAg = 0;
  for(const a of TDB.articles){
    const g = qte(GENERAL, a._id), ag = stockAgences(a._id);
    uGen += g; uAg += ag;
    if(admin){ vGen += Math.max(0,g) * prixTmmb(a._id); for(const x of TDB.agences) vAg += Math.max(0, qte(x._id, a._id)) * prixTmmb(a._id); }
  }
  const bas = lignesStockBas();
  const neg = [...STK.stock.values()].filter(q => q < 0).length;
  document.getElementById('dash-kpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-lbl">Stock général</div><div class="kpi-val kv-yellow">${fmtN(uGen)}</div><div class="kpi-sub">unités${admin ? ' · ' + fmtF(vGen) : ''}</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Stock des agences</div><div class="kpi-val kv-blue">${fmtN(uAg)}</div><div class="kpi-sub">unités${admin ? ' · ' + fmtF(vAg) : ''}</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Stock bas / négatif</div><div class="kpi-val ${bas.length||neg?'kv-red':'kv-green'}">${bas.length} / ${neg}</div><div class="kpi-sub">article(s) × lieu</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Livraisons à vérifier</div><div class="kpi-val ${STK.aVerifier.length?'kv-yellow':'kv-green'}">${STK.aVerifier.length}</div><div class="kpi-sub">non déduites automatiquement</div></div>`
    + (admin ? `<div class="kpi-card admin-seul"><div class="kpi-lbl">💰 Valeur totale du stock</div><div class="kpi-val kv-green">${fmtF(vGen+vAg)}</div><div class="kpi-sub">au prix d'achat TMMB</div></div>
    <div class="kpi-card admin-seul"><div class="kpi-lbl">💰 Achats du mois</div><div class="kpi-val kv-purple" id="dash-achats">…</div><div class="kpi-sub">entrées fournisseurs</div></div>` : '');

  document.getElementById('dash-lieux').innerHTML = '<table class="mini-table" style="width:100%;">' + lieux().map(l => {
    let u = 0, v = 0; for(const a of TDB.articles){ const q = qte(l._id, a._id); u += q; if(admin) v += Math.max(0,q) * prixTmmb(a._id); }
    return `<tr><td>${lieuHtml(l._id)}</td><td style="text-align:right;">${fmtN(u)} unités</td>${admin ? `<td style="text-align:right;font-weight:700;">${fmtF(v)}</td>` : ''}</tr>`;
  }).join('') + '</table>';

  const basRows = bas.map(r => `<tr><td>${esc(r.a.nom)}</td><td class="muted">${lieuHtml(r.l._id)}</td><td class="qte-bas" style="text-align:right;">${fmtN(r.q)} / ${fmtN(r.s)}</td></tr>`);
  document.getElementById('dash-bas').innerHTML = bas.length ? '<table class="mini-table" style="width:100%;"><tbody id="dash-bas-body"></tbody></table>' : '<div class="muted">Aucun article sous son seuil.</div>';
  if(bas.length) paginer('dash-bas-body', basRows, 3, '');

  const d = STK.derniereLecture;
  document.getElementById('dash-liv').innerHTML = !STK.jourJ ? '<div class="muted">Jour J non défini.</div>'
    : d ? `<div style="font-size:13px;">${esc(d.heure)} — ${d.lues} livraison(s) relue(s), <b>${d.deduites}</b> déduite(s), ${d.aVerifier} à vérifier${d.erreur ? ` · <span class="kv-red">${esc(d.erreur)}</span>` : ''}.</div>`
    : '<div class="muted">Lecture en cours…</div>';

  if(admin){
    try{
      const debut = aujourdhui().slice(0,8) + '01';
      const s = await getDocs(query(collection(db,'stk_prixEntrees'), where('date','>=',debut)));
      const tot = _docs(s).filter(p=>!p.annule).reduce((x,p)=>x+(Number(p.qty)||0)*(Number(p.prixAchat)||0),0);
      const el = document.getElementById('dash-achats'); if(el) el.textContent = fmtF(tot);
    }catch(e){ const el = document.getElementById('dash-achats'); if(el) el.textContent = '—'; }
  }
}

/* ═══════════════════════════════════════════════════
   ÉTAT DU STOCK GÉNÉRAL
═══════════════════════════════════════════════════ */
window.renderGeneral = function(){
  const admin = estAdmin();
  const etat = document.getElementById('gen-etat').value;
  const arts = filtrerArticles(document.getElementById('gen-search').value, document.getElementById('gen-cat').value)
    .filter(a => etatOk(etat, qte(GENERAL, a._id), seuil(a._id)));
  let unites = 0, valeur = 0;
  document.getElementById('gen-head').innerHTML = `<tr><th>Réf.</th><th>Article</th><th>Catégorie</th><th>Quantité</th><th>Seuil</th><th>Agences</th>${admin ? '<th>Prix d\'achat</th><th>Valeur</th>' : ''}</tr>`;
  const rows = arts.map(a => {
    const q = qte(GENERAL, a._id), s = seuil(a._id);
    unites += q; const v = Math.max(0,q) * prixTmmb(a._id); valeur += v;
    return `<tr><td>${a.ref ? `<span class="ref-tag" style="margin:0;">${esc(a.ref)}</span>` : ''}</td><td>${esc(a.nom)}</td><td class="muted">${esc(a.cat||'—')}</td>
      <td class="${clsQte(q,s)}">${fmtN(q)} ${esc(a.unite||'')}</td><td>${s ? fmtN(s) : '—'}</td><td class="muted">${fmtN(stockAgences(a._id))}</td>
      ${admin ? `<td>${fmtF(prixTmmb(a._id))}</td><td>${fmtF(v)}</td>` : ''}</tr>`;
  });
  paginer('gen-body', rows, admin ? 8 : 6, 'Aucun article ne correspond aux filtres.');
  document.getElementById('gen-kpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-lbl">Articles affichés</div><div class="kpi-val kv-blue">${arts.length}</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Unités au stock général</div><div class="kpi-val kv-yellow">${fmtN(unites)}</div></div>
    ${admin ? `<div class="kpi-card"><div class="kpi-lbl">💰 Valeur</div><div class="kpi-val kv-green">${fmtF(valeur)}</div></div>`
            : `<div class="kpi-card"><div class="kpi-lbl">En alerte</div><div class="kpi-val kv-red">${arts.filter(a=>seuil(a._id)>0 && qte(GENERAL,a._id)<seuil(a._id)).length}</div></div>`}`;
};

/* ═══════════════════════════════════════════════════
   STOCK PAR AGENCE
═══════════════════════════════════════════════════ */
window.renderAgences = function(){
  const admin = estAdmin();
  const ag = document.getElementById('ag-agence').value, etat = document.getElementById('ag-etat').value;
  const ags = ag ? [IDX.agences.get(ag)].filter(Boolean) : agencesTriees();
  const arts = filtrerArticles(document.getElementById('ag-search').value, document.getElementById('ag-cat').value)
    .filter(a => !etat || ags.some(g => etatOk(etat, qte(g._id, a._id), seuil(a._id))));
  let unites = 0, valeur = 0, rows;
  if(ag){
    document.getElementById('ag-head').innerHTML = `<tr><th>Réf.</th><th>Article</th><th>Catégorie</th><th>Quantité</th><th>Seuil</th>${admin ? '<th>Prix d\'achat</th><th>Valeur</th>' : ''}</tr>`;
    rows = arts.map(a => {
      const q = qte(ag, a._id), s = seuil(a._id), v = Math.max(0,q) * prixTmmb(a._id);
      unites += q; valeur += v;
      return `<tr><td>${a.ref ? `<span class="ref-tag" style="margin:0;">${esc(a.ref)}</span>` : ''}</td><td>${esc(a.nom)}</td><td class="muted">${esc(a.cat||'—')}</td><td class="${clsQte(q,s)}">${fmtN(q)} ${esc(a.unite||'')}</td><td>${s ? fmtN(s) : '—'}</td>${admin ? `<td>${fmtF(prixTmmb(a._id))}</td><td>${fmtF(v)}</td>` : ''}</tr>`;
    });
    paginer('ag-body', rows, admin ? 7 : 5, 'Aucun article ne correspond aux filtres.');
  } else {
    document.getElementById('ag-head').innerHTML = '<tr><th>Article</th>' + ags.map(g=>`<th>${esc(g.nom)}</th>`).join('') + `<th>Total agences</th>${admin ? '<th>Valeur</th>' : ''}</tr>`;
    rows = arts.map(a => {
      const s = seuil(a._id); let t = 0, v = 0;
      const cells = ags.map(g => { const q = qte(g._id, a._id); t += q; v += Math.max(0,q) * prixTmmb(a._id); return `<td class="${clsQte(q,s)}">${fmtN(q)}</td>`; }).join('');
      unites += t; valeur += v;
      return `<tr><td>${esc(a.nom)} ${refTag(a)}</td>${cells}<td style="font-weight:700;">${fmtN(t)}</td>${admin ? `<td>${fmtF(v)}</td>` : ''}</tr>`;
    });
    paginer('ag-body', rows, ags.length + (admin ? 3 : 2), 'Aucun article ne correspond aux filtres.');
  }
  document.getElementById('ag-kpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-lbl">Articles affichés</div><div class="kpi-val kv-blue">${arts.length}</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Unités en agence${ag ? '' : 's'}</div><div class="kpi-val kv-purple">${fmtN(unites)}</div></div>
    ${admin ? `<div class="kpi-card"><div class="kpi-lbl">💰 Valeur</div><div class="kpi-val kv-green">${fmtF(valeur)}</div></div>`
            : `<div class="kpi-card"><div class="kpi-lbl">Agences</div><div class="kpi-val kv-yellow">${ags.length}</div></div>`}`;
};

window.exportStockCsv = function(quoi){
  const admin = estAdmin();
  const ls = quoi === 'general' ? [{ _id:GENERAL, nom:'Stock général' }] : agencesTriees();
  const rows = [['Référence','Article','Catégorie','Unité', ...ls.map(l=>l.nom), 'Total', ...(admin ? ["Prix d'achat",'Valeur'] : [])]];
  for(const a of articlesTries()){
    const qs = ls.map(l=>qte(l._id, a._id)); const t = qs.reduce((x,y)=>x+y,0);
    rows.push([a.ref||'', a.nom||'', a.cat||'', a.unite||'', ...qs, t, ...(admin ? [prixTmmb(a._id), Math.max(0,t)*prixTmmb(a._id)] : [])]);
  }
  telechargerCsv((quoi === 'general' ? 'stock_general_' : 'stock_agences_') + aujourdhui() + '.csv', rows);
};

/* ═══════════════════════════════════════════════════
   ARTICLES (seuil d'alerte propre au stock)
═══════════════════════════════════════════════════ */
let _artEdite = null;
window.renderArticles = function(){
  const admin = estAdmin(), etat = document.getElementById('art-etat').value;
  const arts = filtrerArticles(document.getElementById('art-search').value, document.getElementById('art-cat').value).filter(a => {
    const s = seuil(a._id);
    if(etat === 'seuil') return s > 0;
    if(etat === 'sansseuil') return !s;
    if(etat === 'bas') return s > 0 && lieux().some(l => qte(l._id, a._id) < s);
    return true;
  });
  document.getElementById('art-head').innerHTML = `<tr><th>Réf.</th><th>Article</th><th>Catégorie</th><th>Unité</th>${admin ? '<th>Prix d\'achat TMMB</th>' : ''}<th>Seuil</th><th>Stock général</th><th>Agences</th><th>Total</th><th class="no-print"></th></tr>`;
  const rows = arts.map(a => {
    const id = sid(a._id), s = seuil(a._id);
    return `<tr><td>${a.ref ? `<span class="ref-tag" style="margin:0;">${esc(a.ref)}</span>` : ''}</td><td>${esc(a.nom)}</td><td class="muted">${esc(a.cat||'—')}</td><td>${esc(a.unite||'—')}</td>
      ${admin ? `<td>${fmtF(prixTmmb(a._id))}</td>` : ''}<td>${s ? fmtN(s) : '—'}</td><td>${fmtN(qte(GENERAL,a._id))}</td><td>${fmtN(stockAgences(a._id))}</td><td style="font-weight:700;">${fmtN(stockTotal(a._id))}</td>
      <td class="no-print">${id ? `<button class="btn btn-ghost btn-xs" onclick="ouvrirArticle('${id}')">✏️ Seuil</button>` : ''}</td></tr>`;
  });
  paginer('art-body', rows, admin ? 10 : 9, 'Aucun article ne correspond aux filtres.');
};
window.ouvrirArticle = function(id){
  const a = IDX.articles.get(id); if(!a) return;
  _artEdite = id;
  const r = STK.reglArt.get(id) || {};
  document.getElementById('ma-titre').textContent = '🏷️ ' + (a.nom || id);
  document.getElementById('ma-seuil').value = r.seuil ?? '';
  ouvrirModale('modal-article');
};
window.enregistrerArticle = async function(){
  const id = _artEdite; if(!id) return;
  const sv = document.getElementById('ma-seuil').value.trim();
  if(sv !== '' && !compteValide(sv)) return notify('Seuil invalide (nombre entier ≥ 0)','err');
  const data = { seuil: sv === '' ? null : Number(sv), majLe: serverTimestamp(), majPar: user().name || '' };
  try{
    await setDoc(doc(db,'stk_articles',id), data, { merge:true });
    STK.reglArt.set(id, { ...(STK.reglArt.get(id)||{}), ...data });
    fermerModale('modal-article'); renderArticles(); notify('✅ Seuil enregistré');
  }catch(e){ notify(msgErreur(e),'err'); }
};

/* ═══════════════════════════════════════════════════
   OPÉRATIONS : entrées, dispatch, autres sorties, transferts
   Un même formulaire et un même historique, configurés par type.
   Chaque opération est écrite en une fois (tout ou rien).
═══════════════════════════════════════════════════ */
const OPS = {
  entree:    { type:'entree',    titre:"📥 Nouvelle entrée fournisseur — au stock général", source:null,      dest:'general', histo:'🧾 Entrées enregistrées' },
  dispatch:  { type:'transfert', titre:'🚚 Dispatch du stock général vers une agence',      source:'general', dest:'agence',  histo:'🧾 Dispatchs enregistrés' },
  transfert: { type:'transfert', titre:'🔁 Transfert entre lieux (agence → agence, ou retour au stock général)', source:'agence', dest:'lieu', histo:'🧾 Transferts enregistrés' },
  sortie:    { type:'sortie',    titre:'📤 Autre sortie de stock (perte, usage interne, retour fournisseur…)',  source:'lieu',    dest:null,      histo:'🧾 Sorties enregistrées' }
};
const PAGE_OP = { entrees:'entree', dispatch:'dispatch', transferts:'transfert', sorties:'sortie' };
const _histoMv = new Map();      // id mouvement → mouvement (historiques chargés)
const _prixMap = new Map();      // id mouvement → prix d'entrée (admin)
const _histoGroupes = new Map(); // op → groupes chargés

function construireOperations(){
  for(const [op, c] of Object.entries(OPS)){
    const el = document.querySelector(`[data-op="${op}"]`);
    if(!el || el.dataset.pret) continue;
    el.dataset.pret = '1';
    const sourceHtml = c.source === 'general' ? `<div class="form-group"><div class="form-label">Départ</div><div style="padding:9px 0;">${lieuHtml(GENERAL)}</div></div>`
      : c.source ? `<div class="form-group"><div class="form-label">${c.source === 'lieu' ? 'Lieu concerné' : 'Agence de départ'} *</div><select class="form-control" id="${op}-src" onchange="majLignes('${op}')"></select></div>` : '';
    const destHtml = c.dest === 'general' ? `<div class="form-group"><div class="form-label">Arrivée</div><div style="padding:9px 0;">${lieuHtml(GENERAL)}</div></div>`
      : c.dest ? `<div class="form-group"><div class="form-label">${c.dest === 'agence' ? 'Agence qui reçoit' : "Lieu d'arrivée"} *</div><select class="form-control" id="${op}-dst"></select></div>` : '';
    const motifHtml = op === 'sortie' ? `<div class="form-group"><div class="form-label">Motif *</div><select class="form-control" id="sortie-motif">${Object.entries(MOTIFS_SORTIE).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select></div>` : '';
    const fournHtml = op === 'entree' ? `<div class="form-group"><div class="form-label">Fournisseur *</div><input type="text" class="form-control" id="entree-fourn" maxlength="100" placeholder="Nom du fournisseur"></div>` : '';
    el.innerHTML = `
      <div class="card no-print">
        <div class="card-title">${c.titre}</div>
        <div class="form-row-3">${sourceHtml}${destHtml}${motifHtml}${fournHtml}
          <div class="form-group"><div class="form-label">Date *</div><input type="date" class="form-control" id="${op}-date" value="${aujourdhui()}"></div>
        </div>
        <div class="form-row">
          ${op === 'entree' ? '<div class="form-group"><div class="form-label">N° facture / bon</div><input type="text" class="form-control" id="entree-ref" maxlength="60"></div>' : ''}
          <div class="form-group"><div class="form-label">${op === 'sortie' ? 'Précision (obligatoire pour « Autre »)' : 'Note'}</div><input type="text" class="form-control" id="${op}-note" maxlength="200"></div>
        </div>
        <table class="lignes"><thead id="${op}-lhead"></thead><tbody id="${op}-lignes"></tbody></table>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px;">
          <button class="btn btn-ghost btn-sm" onclick="ajouterLigne('${op}')">+ Ajouter un article</button>
          <div style="flex:1;text-align:right;font-weight:700;" id="${op}-total"></div>
          <button class="btn btn-success" id="btn-${op}" onclick="enregistrerOp('${op}')">✅ Enregistrer</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">${c.histo}</div>
        <div class="filters">
          <span class="date-range"><label>Du</label><input type="date" class="form-control f-sm" id="${op}-hdu" value="${_ilYa(30)}"><label>au</label><input type="date" class="form-control f-sm" id="${op}-hau" value="${aujourdhui()}"></span>
          <button class="btn btn-ghost btn-sm no-print" onclick="chargerHistorique('${op}')">Afficher la période</button>
          ${op !== 'entree' ? `<select class="form-control f-sm" id="${op}-hlieu" onchange="renderHistorique('${op}')"></select>` : ''}
          ${op === 'sortie' ? `<select class="form-control f-sm" id="sortie-hmotif" onchange="renderHistorique('sortie')"><option value="">Tous les motifs</option>${Object.entries(MOTIFS_SORTIE).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select>` : ''}
          ${op === 'entree' ? `<input type="text" class="form-control f-sm" id="entree-hfourn" placeholder="🔍 Fournisseur ou n° facture…" oninput="renderHistorique('entree')">` : ''}
          <input type="text" class="form-control f-sm" id="${op}-hart" placeholder="🔍 Article…" oninput="renderHistorique('${op}')">
          <select class="form-control f-sm" id="${op}-hstat" onchange="renderHistorique('${op}')"><option value="actives">Sans les annulées</option><option value="toutes">Avec les annulées</option><option value="annulees">Annulées seulement</option></select>
        </div>
        <div class="muted admin-seul" style="margin-bottom:8px;">🛡️ Administrateur : ✏️ corrige une ligne (quantité, date, note${op === 'entree' ? ', fournisseur, n° facture' : ''}), 🚫 l'annule${op === 'entree' ? ', 💲 corrige son prix d\'achat' : ''}. Le stock est recalculé et l'historique est gardé.</div>
        <div class="tw"><table><thead id="${op}-hhead"></thead><tbody id="${op}-histo"></tbody></table></div>
      </div>`;
    ajouterLigne(op);
  }
}

function remplirSelectsOperations(optsAg, optGen){
  const garder = (id, html) => { const el = document.getElementById(id); if(!el) return; const v = el.value; el.innerHTML = html; if(v && [...el.options].some(o=>o.value===v)) el.value = v; };
  const choix = '<option value="">— Choisir —</option>';
  garder('dispatch-dst', choix + optsAg);
  garder('transfert-src', choix + optsAg);
  garder('transfert-dst', choix + optGen + optsAg);
  garder('sortie-src', optGen + optsAg);
  garder('dispatch-hlieu', '<option value="">Toutes les agences</option>' + optsAg);
  garder('transfert-hlieu', '<option value="">Tous les lieux</option>' + optGen + optsAg);
  garder('sortie-hlieu', '<option value="">Tous les lieux</option>' + optGen + optsAg);
  for(const op of Object.keys(OPS)){
    const tb = document.getElementById(op + '-lignes');
    if(tb) tb.querySelectorAll('.l-art').forEach(s => { const v = s.value; s.innerHTML = optionsArticles(); s.value = v; });
    majEnteteLignes(op);
  }
}
function sourceOp(op){
  const c = OPS[op];
  if(c.source === 'general') return GENERAL;
  if(c.source) return document.getElementById(op + '-src').value;
  return null;
}
function destOp(op){
  const c = OPS[op];
  if(c.dest === 'general') return GENERAL;
  if(c.dest) return document.getElementById(op + '-dst').value;
  return null;
}
const avecPrixEcran = op => op === 'entree' && estAdmin();
function majEnteteLignes(op){
  const h = document.getElementById(op + '-lhead'); if(!h) return;
  h.innerHTML = `<tr><th>Article</th>${OPS[op].source ? '<th>Disponible</th>' : ''}<th>Quantité</th>${avecPrixEcran(op) ? '<th>Prix TMMB</th><th>Total</th>' : ''}<th></th></tr>`;
}
function optionsArticles(){
  return '<option value="">— Article —</option>' + articlesTries().map(a=>`<option value="${esc(a._id)}">${esc(a.nom)}${a.ref ? ' ('+esc(a.ref)+')' : ''}</option>`).join('');
}
window.ajouterLigne = function(op){
  const tb = document.getElementById(op + '-lignes');
  if(tb.children.length >= MAX_LIGNES) return notify(`Maximum ${MAX_LIGNES} articles par opération`,'warn');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><select class="form-control l-art" onchange="majLignes('${op}')">${optionsArticles()}</select></td>`
    + (OPS[op].source ? '<td class="num l-dispo">—</td>' : '')
    + `<td><input type="number" class="form-control l-qte" min="1" step="1" placeholder="Quantité" oninput="majLignes('${op}')"></td>`
    + (avecPrixEcran(op) ? '<td class="num l-prix">—</td><td class="num l-total">—</td>' : '')
    + `<td><button class="btn btn-ghost btn-xs" onclick="this.closest('tr').remove();majLignes('${op}')">✕</button></td>`;
  tb.appendChild(tr);
  majEnteteLignes(op);
};
window.majLignes = function(op){
  const src = sourceOp(op); let tot = 0;
  document.querySelectorAll(`#${op}-lignes tr`).forEach(tr => {
    const a = tr.querySelector('.l-art').value, q = Number(tr.querySelector('.l-qte').value) || 0;
    const d = tr.querySelector('.l-dispo');
    if(d){ const dispo = src && a ? qte(src, a) : null; d.textContent = dispo == null ? '—' : fmtN(dispo); d.className = 'num l-dispo' + (dispo != null && q > dispo ? ' qte-neg' : ''); }
    if(avecPrixEcran(op)){
      const p = a ? prixTmmb(a) : 0;
      tr.querySelector('.l-prix').textContent = a ? fmtF(p) : '—';
      tr.querySelector('.l-total').textContent = a && q ? fmtF(p*q) : '—';
      tot += p*q;
    }
  });
  const t = document.getElementById(op + '-total');
  if(t) t.textContent = avecPrixEcran(op) ? 'Total : ' + fmtF(tot) : '';
};
function lireLignes(op){
  const out = []; const vus = new Set();
  for(const tr of document.querySelectorAll(`#${op}-lignes tr`)){
    const a = tr.querySelector('.l-art').value, q = tr.querySelector('.l-qte').value;
    if(!a && !q) continue;
    if(!a) throw new Error('Choisissez un article sur chaque ligne remplie');
    if(!IDX.articles.has(a)) throw new Error('Article inconnu');
    if(vus.has(a)) throw new Error(`« ${nomArt(a)} » apparaît deux fois : regroupez les quantités`);
    vus.add(a);
    if(!quantiteValide(q)) throw new Error(`Quantité invalide pour « ${nomArt(a)} » (nombre entier > 0)`);
    out.push({ articleId:a, qty:Number(q) });
  }
  if(!out.length) throw new Error('Ajoutez au moins un article');
  return out;
}
const dateValide = d => /^\d{4}-\d{2}-\d{2}$/.test(d||'') && d <= aujourdhui();

// Regroupe des variations de stock par document (une seule écriture par lieu/article).
function cumul(deltas){
  const m = new Map();
  for(const d of deltas){ const k = cleStock(d.lieu, d.articleId); m.set(k, { ...d, delta:(m.get(k)?.delta || 0) + d.delta }); }
  return [...m.values()].filter(d => d.delta);
}
function ecrireStock(w, d){
  w.set(doc(db,'stk_stock',cleStock(d.lieu,d.articleId)), { agenceId:d.lieu, articleId:d.articleId, qty:increment(d.delta), majLe:serverTimestamp() }, { merge:true });
}
const appliquerLocal = ds => ds.forEach(d => STK.stock.set(cleStock(d.lieu,d.articleId), qte(d.lieu,d.articleId) + d.delta));

window.enregistrerOp = (op) => avecVerrou('op:'+op, 'btn-'+op, async () => {
  const c = OPS[op];
  const src = sourceOp(op), dst = destOp(op);
  const date = document.getElementById(op + '-date').value;
  const note = document.getElementById(op + '-note').value.trim();
  const fourn = op === 'entree' ? document.getElementById('entree-fourn').value.trim() : '';
  const ref = op === 'entree' ? document.getElementById('entree-ref').value.trim() : '';
  const motif = op === 'sortie' ? document.getElementById('sortie-motif').value : '';
  let lignes;
  try{
    if(c.source && !estLieu(src)) throw new Error('Choisissez le lieu de départ');
    if(c.dest && !estLieu(dst)) throw new Error("Choisissez le lieu d'arrivée");
    if(src && dst && src === dst) throw new Error("Le lieu d'arrivée doit être différent du lieu de départ");
    if(!dateValide(date)) throw new Error('Date invalide (pas de date future)');
    if(op === 'entree' && !fourn) throw new Error('Indiquez le fournisseur');
    if(op === 'sortie' && !MOTIFS_SORTIE[motif]) throw new Error('Choisissez le motif');
    if(op === 'sortie' && motif === 'autre' && !note) throw new Error('Précisez le motif de la sortie');
    lignes = lireLignes(op);
    if(src){
      const manque = lignes.filter(l => l.qty > qte(src, l.articleId));
      if(manque.length) throw new Error(`Stock insuffisant (${nomLieu(src)}) : ` + manque.map(l=>`${nomArt(l.articleId)} — disponible ${fmtN(qte(src,l.articleId))}`).join(', '));
    }
  }catch(e){ return notify(e.message,'err'); }
  const resume = op === 'entree' ? `l'entrée de ${lignes.length} article(s) au stock général`
    : op === 'sortie' ? `la sortie de ${lignes.length} article(s) de ${nomLieu(src)} (${MOTIFS_SORTIE[motif]})`
    : `le transfert de ${lignes.length} article(s) de ${nomLieu(src)} vers ${nomLieu(dst)}`;
  if(!confirm(`Enregistrer ${resume} ?`)) return;

  const groupe = doc(collection(db,'stk_mouvements')).id;
  const b = writeBatch(db);
  const deltas = [];
  for(const l of lignes){
    const mvRef = doc(collection(db,'stk_mouvements'));
    const base = { articleId:l.articleId, date, note:note.slice(0,200), groupeId:groupe, ts:serverTimestamp(), ...auteur() };
    if(op === 'entree'){
      deltas.push({ lieu:GENERAL, articleId:l.articleId, delta:l.qty });
      b.set(mvRef, { ...base, type:'entree', agenceId:GENERAL, qty:l.qty, fournisseur:fourn.slice(0,100), ref:ref.slice(0,60) });
      // Prix d'achat : celui de l'article dans TMMB au moment de l'entrée. Collection réservée à l'admin.
      b.set(doc(db,'stk_prixEntrees',mvRef.id), { articleId:l.articleId, qty:l.qty, prixAchat:prixTmmb(l.articleId), date, groupeId:groupe,
        fournisseur:fourn.slice(0,100), ref:ref.slice(0,60), annule:false, creeLe:serverTimestamp(), ...auteur() });
    } else if(op === 'sortie'){
      deltas.push({ lieu:src, articleId:l.articleId, delta:-l.qty });
      b.set(mvRef, { ...base, type:'sortie', agenceId:src, qty:-l.qty, motifSortie:motif });
    } else {
      deltas.push({ lieu:src, articleId:l.articleId, delta:-l.qty }, { lieu:dst, articleId:l.articleId, delta:l.qty });
      b.set(mvRef, { ...base, type:'transfert', agenceId:src, agenceDestId:dst, qty:l.qty });
    }
  }
  const ds = cumul(deltas);
  ds.forEach(d => ecrireStock(b, d));
  try{
    await b.commit();
    appliquerLocal(ds);
    document.getElementById(op + '-lignes').innerHTML = ''; ajouterLigne(op);
    [op+'-note','entree-fourn','entree-ref'].forEach(id => { const el = document.getElementById(id); if(el && (id.startsWith(op) || op === 'entree')) el.value = ''; });
    majLignes(op); chargerHistorique(op);
    notify('✅ Enregistré');
  }catch(e){ notify(msgErreur(e),'err'); }
});

/* ─── Historique d'une opération ─── */
function correspondOp(op, m){
  if(op === 'entree') return m.type === 'entree';
  if(op === 'sortie') return m.type === 'sortie';
  if(op === 'dispatch') return m.type === 'transfert' && m.agenceId === GENERAL;
  return m.type === 'transfert' && m.agenceId !== GENERAL;
}
window.chargerHistorique = async function(op){
  const du = document.getElementById(op + '-hdu').value, au = document.getElementById(op + '-hau').value;
  const tb = document.getElementById(op + '-histo');
  if(!du || !au || du > au) return notify('Période invalide','err');
  tb.innerHTML = '<tr><td class="emp">Chargement…</td></tr>';
  try{
    const reqs = [getDocs(query(collection(db,'stk_mouvements'), where('date','>=',du), where('date','<=',au)))];
    if(op === 'entree' && estAdmin()) reqs.push(getDocs(query(collection(db,'stk_prixEntrees'), where('date','>=',du), where('date','<=',au))));
    const [snap, prix] = await Promise.all(reqs);
    const mv = _docs(snap).filter(m => correspondOp(op, m));
    mv.forEach(m => _histoMv.set(m._id, m));
    if(prix) _docs(prix).forEach(p => _prixMap.set(p._id, p));
    const grp = new Map();
    for(const m of mv){ const k = m.groupeId || m._id; if(!grp.has(k)) grp.set(k, []); grp.get(k).push(m); }
    _histoGroupes.set(op, [...grp.values()].sort((a,b)=>String(b[0].date).localeCompare(String(a[0].date)) || ((b[0].ts?.seconds||0)-(a[0].ts?.seconds||0))));
    renderHistorique(op);
  }catch(e){ tb.innerHTML = `<tr><td class="emp">${esc(msgErreur(e))}</td></tr>`; }
};
window.renderHistorique = function(op){
  const admin = estAdmin();
  const stat = document.getElementById(op + '-hstat').value;
  const art = (document.getElementById(op + '-hart').value || '').trim().toLowerCase();
  const lieu = document.getElementById(op + '-hlieu')?.value || '';
  const mot = op === 'sortie' ? document.getElementById('sortie-hmotif').value : '';
  const fourn = op === 'entree' ? (document.getElementById('entree-hfourn').value || '').trim().toLowerCase() : '';
  const groupes = (_histoGroupes.get(op) || []).map(g => g.filter(m => {
    if(stat === 'actives' && m.annule) return false;
    if(stat === 'annulees' && !m.annule) return false;
    if(art){ const a = IDX.articles.get(m.articleId) || {}; if(!String(a.nom||'').toLowerCase().includes(art) && !String(a.ref||'').toLowerCase().includes(art)) return false; }
    if(lieu && op === 'dispatch' && m.agenceDestId !== lieu) return false;
    if(lieu && op === 'transfert' && m.agenceId !== lieu && m.agenceDestId !== lieu) return false;
    if(lieu && op === 'sortie' && m.agenceId !== lieu) return false;
    if(mot && m.motifSortie !== mot) return false;
    if(fourn && !String(m.fournisseur||'').toLowerCase().includes(fourn) && !String(m.ref||'').toLowerCase().includes(fourn)) return false;
    return true;
  })).filter(g => g.length);

  const head = { entree:`<th>Date</th><th>Fournisseur</th><th>Articles</th>${admin ? '<th>Montant</th>' : ''}<th>Par</th>`,
                 dispatch:'<th>Date</th><th>Agence</th><th>Articles</th><th>Note</th><th>Par</th>',
                 transfert:'<th>Date</th><th>Départ → arrivée</th><th>Articles</th><th>Note</th><th>Par</th>',
                 sortie:'<th>Date</th><th>Lieu</th><th>Motif</th><th>Articles</th><th>Par</th>' }[op];
  document.getElementById(op + '-hhead').innerHTML = '<tr>' + head + '</tr>';
  let total = 0;
  const rows = groupes.map(g => {
    const m = g[0];
    const lignes = g.map(x => ligneOperation(op, x, admin)).join('');
    const actives = g.filter(x => !x.annule);
    const toutAnnuler = admin && actives.length > 1 ? `<div class="no-print" style="margin-top:4px;"><button class="btn btn-ghost btn-xs" onclick="ouvrirAnnulation('${sid(m.groupeId || m._id)}','${op}')">🚫 Annuler toute l'opération</button></div>` : '';
    const auteurTxt = `<td class="muted">${esc(m.auteurNom||'')}</td>`;
    if(op === 'entree'){
      const mt = actives.reduce((s,x)=>{ const p = _prixMap.get(x._id); return s + (p ? (Number(x.qty)||0) * (Number(p.prixAchat)||0) : 0); }, 0);
      total += mt;
      return `<tr><td>${dateFr(m.date)}</td><td>${esc(m.fournisseur||'')}${m.ref ? `<div class="muted">${esc(m.ref)}</div>` : ''}${m.note ? `<div class="muted">${esc(m.note)}</div>` : ''}</td><td style="font-size:12px;">${lignes}${toutAnnuler}</td>${admin ? `<td style="font-weight:700;">${fmtF(mt)}</td>` : ''}${auteurTxt}</tr>`;
    }
    if(op === 'dispatch') return `<tr><td>${dateFr(m.date)}</td><td>${lieuHtml(m.agenceDestId)}</td><td style="font-size:12px;">${lignes}${toutAnnuler}</td><td class="muted">${esc(m.note||'')}</td>${auteurTxt}</tr>`;
    if(op === 'transfert') return `<tr><td>${dateFr(m.date)}</td><td>${lieuHtml(m.agenceId)} → ${lieuHtml(m.agenceDestId)}</td><td style="font-size:12px;">${lignes}${toutAnnuler}</td><td class="muted">${esc(m.note||'')}</td>${auteurTxt}</tr>`;
    return `<tr><td>${dateFr(m.date)}</td><td>${lieuHtml(m.agenceId)}</td><td>${esc(MOTIFS_SORTIE[m.motifSortie] || m.motifSortie || '')}${m.note ? `<div class="muted">${esc(m.note)}</div>` : ''}</td><td style="font-size:12px;">${lignes}${toutAnnuler}</td>${auteurTxt}</tr>`;
  });
  if(op === 'entree' && admin && rows.length) rows.push(`<tr class="st-total"><td colspan="3">TOTAL DES ACHATS AFFICHÉS (hors annulés)</td><td>${fmtF(total)}</td><td></td></tr>`);
  paginer(op + '-histo', rows, op === 'entree' && admin ? 5 : 5, 'Aucune opération pour ces filtres.');
};
function ligneOperation(op, x, admin){
  const id = sid(x._id);
  const modifie = Array.isArray(x.historique) && x.historique.some(h => h.action === 'correction');
  const p = op === 'entree' && admin ? _prixMap.get(x._id) : null;
  const prixTxt = p ? ` @ ${fmtF(p.prixAchat)}${Array.isArray(p.corrections) && p.corrections.length ? ' <span class="tag-corrige">prix corrigé</span>' : ''}${!Number(p.prixAchat) ? ' <span class="tag-annule">prix à 0</span>' : ''}` : '';
  const tags = (x.annule ? ` <span class="tag-annule" title="${esc((x.annulePar||'') + ' — ' + (x.motifAnnulation||''))}">annulé</span>` : '') + (modifie ? ' <span class="tag-modifie">modifié</span>' : '');
  const actions = admin && id && !x.annule ? ` <span class="no-print"><button class="btn btn-ghost btn-xs" title="Corriger" onclick="ouvrirCorrection('${id}')">✏️</button><button class="btn btn-ghost btn-xs" title="Annuler" onclick="ouvrirAnnulation('${id}','${op}',true)">🚫</button>${op === 'entree' ? `<button class="btn btn-ghost btn-xs" title="Corriger le prix" onclick="ouvrirCorrectionPrix('${id}')">💲</button>` : ''}</span>` : '';
  return `<div class="op-ligne ${x.annule ? 'op-annulee' : ''}"><span class="op-txt">${esc(nomArt(x.articleId))} × ${fmtN(qteAffichee(x))}${prixTxt}</span>${tags}${actions}</div>`;
}

/* ═══════════════════════════════════════════════════
   CORRECTION ET ANNULATION (administrateur)
   - corriger : quantité, date, note (+ fournisseur, n° facture pour une entrée) ;
     le stock reçoit la DIFFÉRENCE ; l'avant/après est gardé dans « historique » ;
   - annuler : le stock est rétabli, l'opération reste visible, barrée ;
   - livraisons TMMB et écarts d'inventaire ne se corrigent pas ici
     (livraisons : page Livraisons ; inventaire : refaire un inventaire).
═══════════════════════════════════════════════════ */
let _mcId = null;
window.ouvrirCorrection = function(id){
  if(!estAdmin()) return notify("Réservé à l'administrateur",'err');
  const m = _histoMv.get(id); if(!m || m.annule || !TYPES_CORRIGEABLES.includes(m.type)) return;
  _mcId = id;
  const quoi = m.type === 'entree' ? 'Entrée fournisseur' : m.type === 'sortie' ? 'Sortie (' + (MOTIFS_SORTIE[m.motifSortie]||'') + ')' : 'Transfert';
  document.getElementById('mc-titre').textContent = '✏️ Corriger — ' + quoi;
  document.getElementById('mc-info').innerHTML = `<b>${esc(nomArt(m.articleId))}</b><br>${m.type === 'transfert' ? `${lieuHtml(m.agenceId)} → ${lieuHtml(m.agenceDestId)}` : lieuHtml(m.agenceId)} · saisi par ${esc(m.auteurNom||'')}`;
  document.getElementById('mc-qty').value = qteAffichee(m);
  document.getElementById('mc-date').value = m.date || '';
  document.getElementById('mc-note').value = m.note || '';
  document.getElementById('mc-ligne-fourn').style.display = m.type === 'entree' ? '' : 'none';
  document.getElementById('mc-fourn').value = m.fournisseur || '';
  document.getElementById('mc-ref').value = m.ref || '';
  document.getElementById('mc-motif').value = '';
  document.getElementById('mc-histo').innerHTML = historiqueHtml(m);
  ouvrirModale('modal-corr');
};
function historiqueHtml(m){
  const h = Array.isArray(m.historique) ? m.historique : [];
  if(!h.length) return '';
  return 'Historique :<br>' + h.map(x => {
    const ch = x.avant && x.apres ? Object.keys(x.apres).filter(k => String(x.avant[k]??'') !== String(x.apres[k]??'')).map(k => `${k} : ${esc(x.avant[k]??'—')} → ${esc(x.apres[k]??'—')}`).join(', ') : '';
    return `${esc(x.le ? new Date(x.le).toLocaleString('fr-FR') : '')} — ${x.action === 'annulation' ? 'annulation' : 'correction'} par ${esc(x.par||'')}${ch ? ' (' + ch + ')' : ''} — « ${esc(x.motif||'')} »`;
  }).join('<br>');
}
window.enregistrerCorrection = () => avecVerrou('corr', 'btn-mc', async () => {
  const m0 = _histoMv.get(_mcId); if(!m0) return;
  const q = document.getElementById('mc-qty').value, date = document.getElementById('mc-date').value;
  const note = document.getElementById('mc-note').value.trim(), motif = document.getElementById('mc-motif').value.trim();
  const fourn = document.getElementById('mc-fourn').value.trim(), ref = document.getElementById('mc-ref').value.trim();
  if(!quantiteValide(q)) return notify('Quantité invalide (nombre entier > 0)','err');
  if(!dateValide(date)) return notify('Date invalide (pas de date future)','err');
  if(m0.type === 'entree' && !fourn) return notify('Le fournisseur ne peut pas être vide','err');
  if(!motif) return notify('Indiquez le motif de la correction','err');
  const avant = { quantite:qteAffichee(m0), date:m0.date||'', note:m0.note||'', ...(m0.type === 'entree' ? { fournisseur:m0.fournisseur||'', ref:m0.ref||'' } : {}) };
  const apres = { quantite:Number(q), date, note, ...(m0.type === 'entree' ? { fournisseur:fourn, ref } : {}) };
  if(JSON.stringify(avant) === JSON.stringify(apres)) return notify('Aucune modification','warn');
  // Alerte si la correction rend un stock négatif.
  const prev = deltasCorrection(m0, Number(q)).deltas.map(d => ({ ...d, articleId:m0.articleId }));
  const negatifs = prev.filter(d => qte(d.lieu, d.articleId) + d.delta < 0);
  if(negatifs.length && !confirm('Cette correction rendra le stock négatif à : ' + negatifs.map(d=>nomLieu(d.lieu)).join(', ') + '. Continuer ?')) return;
  const ref1 = doc(db,'stk_mouvements',m0._id), refP = doc(db,'stk_prixEntrees',m0._id);
  try{
    const res = await runTransaction(db, async (tx) => {
      const s = await tx.get(ref1);
      const pr = m0.type === 'entree' ? await tx.get(refP) : null;
      if(!s.exists()) throw new Error('Opération introuvable');
      const m = { ...s.data(), _id:s.id };
      if(m.annule) throw new Error('Opération déjà annulée');
      const { qtyStockee, deltas } = deltasCorrection(m, Number(q));
      const ds = cumul(deltas.map(d => ({ ...d, articleId:m.articleId })));
      ds.forEach(d => ecrireStock(tx, d));
      const hist = [...(Array.isArray(m.historique) ? m.historique : []),
        { action:'correction', le:new Date().toISOString(), par:user().name||'', parId:user().id||'', motif:motif.slice(0,200), avant, apres }].slice(-30);
      const maj = { qty:qtyStockee, date, note:note.slice(0,200), historique:hist, modifieLe:serverTimestamp(), modifiePar:user().name||'' };
      if(m.type === 'entree'){ maj.fournisseur = fourn.slice(0,100); maj.ref = ref.slice(0,60); }
      tx.update(ref1, maj);
      if(pr && pr.exists()) tx.update(refP, { qty:Number(q), date, fournisseur:fourn.slice(0,100), ref:ref.slice(0,60) });
      return { ds, maj };
    });
    appliquerLocal(res.ds);
    Object.assign(m0, res.maj, { modifieLe:null });
    fermerModale('modal-corr');
    rechargerApresAdmin();
    notify('✅ Correction enregistrée');
  }catch(e){ notify(msgErreur(e),'err'); }
});

let _mnCible = null;   // { ids:[...], op }
window.ouvrirAnnulation = function(cle, op, uneLigne){
  if(!estAdmin()) return notify("Réservé à l'administrateur",'err');
  const ids = uneLigne ? [cle] : [..._histoMv.values()].filter(m => (m.groupeId || m._id) === cle && !m.annule).map(m => m._id);
  if(!ids.length) return;
  _mnCible = { ids, op };
  const ms = ids.map(i => _histoMv.get(i));
  document.getElementById('mn-info').innerHTML = `${ms.length > 1 ? `<b>Toute l'opération</b> (${ms.length} lignes) :<br>` : ''}` +
    ms.map(m => `${esc(nomArt(m.articleId))} × ${fmtN(qteAffichee(m))} — ${m.type === 'transfert' ? `${lieuHtml(m.agenceId)} → ${lieuHtml(m.agenceDestId)}` : lieuHtml(m.agenceId)} — ${dateFr(m.date)}`).join('<br>');
  document.getElementById('mn-motif').value = '';
  ouvrirModale('modal-annul');
};
window.confirmerAnnulation = () => avecVerrou('annul', 'btn-mn', async () => {
  if(!_mnCible) return;
  const motif = document.getElementById('mn-motif').value.trim();
  if(!motif) return notify("Indiquez le motif de l'annulation",'err');
  const refs = _mnCible.ids.map(id => doc(db,'stk_mouvements',id));
  try{
    const res = await runTransaction(db, async (tx) => {
      const snaps = await Promise.all(refs.map(r => tx.get(r)));
      const prix = await Promise.all(snaps.map(s => s.exists() && s.data().type === 'entree' ? tx.get(doc(db,'stk_prixEntrees',s.id)) : null));
      const deltas = [], majs = [];
      snaps.forEach((s, i) => {
        if(!s.exists()) return;
        const m = s.data();
        if(m.annule || !TYPES_CORRIGEABLES.includes(m.type)) return;
        deltasAnnulation(m).forEach(d => deltas.push({ ...d, articleId:m.articleId }));
        const hist = [...(Array.isArray(m.historique) ? m.historique : []), { action:'annulation', le:new Date().toISOString(), par:user().name||'', parId:user().id||'', motif:motif.slice(0,200) }].slice(-30);
        const maj = { annule:true, annuleLe:serverTimestamp(), annulePar:user().name||'', annuleParId:user().id||'', motifAnnulation:motif.slice(0,200), historique:hist };
        tx.update(refs[i], maj); majs.push([s.id, maj]);
        if(prix[i] && prix[i].exists()) tx.update(doc(db,'stk_prixEntrees',s.id), { annule:true });
      });
      const ds = cumul(deltas);
      ds.forEach(d => ecrireStock(tx, d));
      return { ds, majs };
    });
    appliquerLocal(res.ds);
    res.majs.forEach(([id, maj]) => { const m = _histoMv.get(id); if(m) Object.assign(m, maj); const p = _prixMap.get(id); if(p) p.annule = true; });
    fermerModale('modal-annul');
    rechargerApresAdmin();
    notify(`✅ ${res.majs.length} ligne(s) annulée(s), stock rétabli`);
  }catch(e){ notify(msgErreur(e),'err'); }
});
function rechargerApresAdmin(){
  const op = PAGE_OP[curPg];
  if(op){ renderHistorique(op); majLignes(op); }
  else if(curPg === 'valeurs') renderValeurs();
  else if(curPg === 'mouvements') renderMouvements();
}

/* ─── Correction du prix d'achat d'une ligne d'entrée (administrateur) ─── */
let _mpId = null;
window.ouvrirCorrectionPrix = function(id){
  if(!estAdmin()) return notify("Réservé à l'administrateur",'err');
  const p = _prixMap.get(id); if(!p) return notify('Prix introuvable pour cette ligne','err');
  if(p.annule) return notify('Ligne annulée','warn');
  _mpId = id;
  document.getElementById('mp-info').innerHTML = `<b>${esc(nomArt(p.articleId))}</b> — ${fmtN(p.qty)} unité(s)<br>Entrée du ${dateFr(p.date)} · ${esc(p.fournisseur||'')}${p.ref ? ' · ' + esc(p.ref) : ''}<br>Prix actuel : <b>${fmtF(p.prixAchat)}</b> — montant : <b>${fmtF((Number(p.qty)||0)*(Number(p.prixAchat)||0))}</b><br><span class="muted">Prix d'achat TMMB aujourd'hui : ${fmtF(prixTmmb(p.articleId))}</span>`;
  document.getElementById('mp-prix').value = p.prixAchat ?? '';
  document.getElementById('mp-motif').value = '';
  const h = Array.isArray(p.corrections) ? p.corrections : [];
  document.getElementById('mp-histo').innerHTML = h.length ? 'Corrections précédentes :<br>' + h.map(c => `${esc(c.le ? new Date(c.le).toLocaleString('fr-FR') : '')} — ${esc(fmtF(c.ancien))} → ${esc(fmtF(c.nouveau))} par ${esc(c.par||'')} (${esc(c.motif||'')})`).join('<br>') : '';
  majApercuPrix();
  ouvrirModale('modal-prix');
};
window.majApercuPrix = function(){
  const p = _prixMap.get(_mpId); const v = document.getElementById('mp-prix').value;
  document.getElementById('mp-total').textContent = p && v !== '' && prixValide(v) ? fmtF((Number(p.qty)||0) * Number(v)) : '—';
};
window.enregistrerCorrectionPrix = () => avecVerrou('prix', 'btn-mp', async () => {
  const p = _prixMap.get(_mpId); if(!p) return;
  const v = document.getElementById('mp-prix').value.trim(), motif = document.getElementById('mp-motif').value.trim();
  if(v === '' || !prixValide(v)) return notify('Prix invalide','err');
  if(Number(v) === Number(p.prixAchat)) return notify('Le prix est identique','warn');
  if(!motif) return notify('Indiquez le motif de la correction','err');
  const ref = doc(db,'stk_prixEntrees',p._id);
  try{
    const corrections = await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      if(!s.exists()) throw new Error('Ligne introuvable');
      const cur = s.data();
      if(cur.annule) throw new Error('Ligne annulée');
      const c = [...(Array.isArray(cur.corrections) ? cur.corrections : []),
        { ancien:Number(cur.prixAchat)||0, nouveau:Number(v), par:user().name||'', parId:user().id||'', le:new Date().toISOString(), motif:motif.slice(0,200) }].slice(-20);
      tx.update(ref, { prixAchat:Number(v), corrections:c, corrigeLe:serverTimestamp(), corrigePar:user().name||'' });
      return c;
    });
    Object.assign(p, { prixAchat:Number(v), corrections });
    fermerModale('modal-prix');
    rechargerApresAdmin();
    notify('✅ Prix corrigé');
  }catch(e){ notify(msgErreur(e),'err'); }
});

/* ═══════════════════════════════════════════════════
   INVENTAIRES
   - l'admin inventorie tous les lieux ; le gestionnaire seulement les agences
     (jamais le stock général) — contrôlé aussi par les règles Firestore ;
   - un seul inventaire en cours par lieu ;
   - 1er inventaire validé d'un lieu = départ (case vide = 0), ensuite périodique
     (case vide = non compté) ;
   - à la validation, le stock devient la quantité comptée ; l'écart est calculé
     sur le stock théorique AU MOMENT DE LA VALIDATION et journalisé ;
   - validation par paquets en transaction (reprise possible si coupure) ;
   - la dernière étape crée le rapport d'inventaire numéroté (RI-AAAA-NNNN).
═══════════════════════════════════════════════════ */
let _inv = null;
const peutInventorier = lieu => lieu !== GENERAL || estAdmin();
window.renderInventaires = function(){
  document.getElementById('inv-liste').style.display = '';
  document.getElementById('inv-saisie').style.display = 'none';
  _inv = null;
  document.getElementById('inv-regle').innerHTML = (estAdmin()
    ? 'Vous pouvez inventorier le <b>stock général</b> et toutes les agences.'
    : 'Vous pouvez inventorier les <b>agences</b>. L\'inventaire du stock général est fait par l\'administrateur.')
    + ' Le <b>premier inventaire</b> d\'un lieu est l\'<b>inventaire de départ</b>. À la validation, un <b>rapport numéroté</b> est créé et peut être imprimé.';
  const fl = document.getElementById('inv-f-lieu').value, ft = document.getElementById('inv-f-type').value, fs = document.getElementById('inv-f-statut').value;
  const du = document.getElementById('inv-f-du').value, au = document.getElementById('inv-f-au').value;
  const liste = STK.inventaires.filter(i => (!fl || i.agenceId === fl) && (!ft || i.type === ft)
    && (!fs || (fs === 'valide' ? i.statut === 'valide' : i.statut !== 'valide')) && (!du || i.date >= du) && (!au || i.date <= au));
  const rows = liste.map(i => {
    const id = sid(i._id), nb = i.statut === 'valide' ? (i.lignes||[]).length : Object.keys(i.comptes||{}).length;
    const ouvrable = id && (i.statut === 'valide' || peutInventorier(i.agenceId));
    return `<tr><td>${dateFr(i.date)}</td><td>${lieuHtml(i.agenceId)}</td>
      <td>${i.type==='depart' ? '<span class="tag tag-purple tag-sm">Départ</span>' : '<span class="tag tag-blue tag-sm">Périodique</span>'}</td>
      <td>${i.statut==='valide' ? '<span class="tag tag-green tag-sm">Validé</span>' : '<span class="tag tag-warn tag-sm">En cours</span>'}</td>
      <td>${fmtN(nb)}</td><td>${i.statut==='valide' ? fmtN(i.nbEcarts||0) : '—'}</td><td class="muted">${esc(i.validePar || i.creePar || '')}</td>
      <td>${i.rapportId && sid(i.rapportId) ? `<a href="#" onclick="voirRapport('${sid(i.rapportId)}');return false;">${esc(i.rapportNumero||'Voir')}</a>` : '—'}</td>
      <td class="no-print">${ouvrable ? `<button class="btn btn-ghost btn-xs" onclick="ouvrirInventaire('${id}')">${i.statut==='valide' ? '👁️ Voir' : '✏️ Continuer'}</button>` : ''}</td></tr>`;
  });
  paginer('inv-body', rows, 9, "Aucun inventaire. Commencez par l'inventaire de départ de chaque lieu.");
};
window.nouvelInventaire = async function(){
  const lieu = document.getElementById('inv-new-lieu').value;
  if(!estLieu(lieu)) return notify('Choisissez le lieu à inventorier','err');
  if(!peutInventorier(lieu)) return notify("L'inventaire du stock général est réservé à l'administrateur",'err');
  const enCours = STK.inventaires.find(i => i.agenceId === lieu && i.statut !== 'valide');
  if(enCours){ notify('Un inventaire est déjà en cours pour ce lieu : il est rouvert','warn'); return ouvrirInventaire(enCours._id); }
  const type = STK.inventaires.some(i => i.agenceId === lieu && i.statut === 'valide') ? 'periodique' : 'depart';
  if(!confirm(`Commencer l'inventaire ${type==='depart' ? 'de DÉPART' : 'périodique'} de ${nomLieu(lieu)} ?`)) return;
  const ref = doc(collection(db,'stk_inventaires'));
  const data = { agenceId:lieu, type, date:aujourdhui(), statut:'brouillon', comptes:{}, articlesValides:[], lignes:[], creeLe:serverTimestamp(), creePar:user().name||'', creeParId:user().id||'' };
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
  document.getElementById('inv-titre').textContent = `Inventaire ${i.type==='depart' ? 'de départ' : 'périodique'} — ${nomLieu(i.agenceId)} — ${dateFr(i.date)}`;
  document.getElementById('inv-aide').innerHTML = i.statut === 'valide'
    ? `Inventaire validé par ${esc(i.validePar||'')}. Il ne peut plus être modifié.${i.rapportId ? ` <a href="#" onclick="voirRapport('${sid(i.rapportId)}');return false;">Voir le rapport ${esc(i.rapportNumero||'')}</a>` : ''}`
    : i.type === 'depart'
      ? "Saisissez la quantité <b>réellement comptée</b> de chaque article. <b>Case vide = 0</b> à la validation. Enregistrez le brouillon régulièrement si le comptage est long."
      : "Saisissez la quantité comptée des articles vérifiés. <b>Case vide = article non compté</b> (son stock ne change pas). L'écart est calculé au moment de la validation.";
  document.getElementById('inv-actions').style.display = i.statut === 'valide' ? 'none' : '';
  document.getElementById('inv-search').value = ''; document.getElementById('inv-filtre').value = '';
  renderSaisieInventaire();
};
window.fermerInventaire = function(){ renderInventaires(); };
window.renderSaisieInventaire = function(){
  if(!_inv) return;
  const ro = _inv.statut === 'valide';
  const filtre = document.getElementById('inv-filtre').value;
  const det = ro ? new Map((_inv.lignes||[]).map(l=>[l.articleId,l])) : null;
  const arts = filtrerArticles(document.getElementById('inv-search').value, document.getElementById('inv-cat').value);
  const rows = [];
  for(const a of arts){
    let theo, compte, ecart;
    if(ro){ const l = det.get(a._id); if(!l) continue; theo = l.theorique; compte = l.compte; ecart = l.ecart; }
    else {
      theo = qte(_inv.agenceId, a._id);
      const v = _inv.comptes[a._id];
      compte = v; ecart = (v === '' || v == null) ? null : Number(v) - theo;
    }
    const saisi = compte !== '' && compte != null;
    if(filtre === 'restant' && saisi) continue;
    if(filtre === 'saisis' && !saisi) continue;
    if(filtre === 'ecarts' && !ecart) continue;
    const ec = ecart == null ? '<span class="muted">—</span>' : `<span class="${ecart>0?'ecart-pos':ecart<0?'ecart-neg':''}">${ecart>0?'+':''}${fmtN(ecart)}</span>`;
    const saisie = ro ? fmtN(compte) : `<input type="number" class="inv-input" min="0" step="1" value="${compte==null?'':esc(compte)}" data-art="${esc(a._id)}" oninput="saisirCompte(this)">`;
    rows.push(`<tr><td>${esc(a.nom)} ${refTag(a)}</td><td>${fmtN(theo)}</td><td>${saisie}</td><td class="inv-ec">${ec}</td></tr>`);
  }
  paginer('inv-lignes', rows, 4, 'Aucun article pour ces filtres.');
  majProgression();
};
function majProgression(){
  const el = document.getElementById('inv-progression'); if(!el || !_inv) return;
  el.textContent = _inv.statut === 'valide' ? `${fmtN((_inv.lignes||[]).length)} article(s) dans l'inventaire`
    : `${fmtN(Object.keys(_inv.comptes).length)} / ${fmtN(TDB.articles.length)} article(s) comptés`;
}
window.saisirCompte = function(inp){
  if(!_inv) return;
  const id = inp.dataset.art, v = inp.value.trim();
  if(v === '') delete _inv.comptes[id]; else _inv.comptes[id] = v;
  const td = inp.closest('tr').querySelector('.inv-ec');
  majProgression();
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
  if(!peutInventorier(_inv.agenceId)) return notify("L'inventaire du stock général est réservé à l'administrateur",'err');
  let comptes; try{ comptes = comptesPropres(); }catch(e){ return notify(e.message,'err'); }
  const lieu = _inv.agenceId, type = _inv.type;
  const deja = new Set(_inv.articlesValides || []);
  const ids = articlesTries().map(a=>a._id).filter(id => !deja.has(id));
  const prevu = calculInventaire(ids, comptes, id => qte(lieu,id), type);
  if(!prevu.length && !deja.size) return notify('Aucun article compté','err');
  const vides = type === 'depart' ? ids.filter(id => !(id in comptes)).length : 0;
  const nbEc = prevu.filter(l=>l.ecart).length;
  if(!confirm(`Valider l'inventaire de ${nomLieu(lieu)} ?\n\n• ${prevu.length} article(s) pris en compte\n• ${nbEc} écart(s) corrigé(s)` + (vides ? `\n• ${vides} article(s) non saisi(s) mis à 0` : '') + "\n\nLe stock deviendra la quantité comptée et un rapport d'inventaire sera créé. Cette action est définitive.")) return;
  const invRef = doc(db,'stk_inventaires',_inv._id);
  try{
    await updateDoc(invRef, { comptes, statut:'validation_en_cours', majLe:serverTimestamp() });
    for(let k = 0; k < ids.length; k += INV_PAQUET){
      const paquet = ids.slice(k, k + INV_PAQUET);
      const faites = await runTransaction(db, async (tx) => {
        const inv = await tx.get(invRef);
        const dejaTx = new Set((inv.data() && inv.data().articlesValides) || []);
        const aFaire = paquet.filter(id => !dejaTx.has(id));
        const snaps = await Promise.all(aFaire.map(id => tx.get(doc(db,'stk_stock',cleStock(lieu,id)))));
        const actuel = new Map(aFaire.map((id,j) => [id, snaps[j].exists() ? (Number(snaps[j].data().qty)||0) : 0]));
        const lignes = calculInventaire(aFaire, comptes, id => actuel.get(id), type);
        for(const l of lignes){
          tx.set(doc(db,'stk_stock',cleStock(lieu,l.articleId)), { agenceId:lieu, articleId:l.articleId, qty:l.compte, majLe:serverTimestamp() }, { merge:true });
          if(l.ecart) tx.set(doc(collection(db,'stk_mouvements')), { type:'inventaire', articleId:l.articleId, agenceId:lieu, qty:l.ecart,
            theorique:l.theorique, compte:l.compte, inventaireId:_inv._id, inventaireType:type, date:aujourdhui(), ts:serverTimestamp(), ...auteur() });
        }
        tx.update(invRef, { articlesValides:[...dejaTx, ...aFaire], lignes:[...((inv.data() && inv.data().lignes) || []), ...lignes] });
        return lignes;
      });
      for(const l of faites) STK.stock.set(cleStock(lieu,l.articleId), l.compte);
    }
    // Dernière étape (une seule transaction) : rapport numéroté + inventaire validé.
    const fin = await runTransaction(db, async (tx) => {
      const cRef = doc(db,'stk_config','compteurs');
      const [inv, cpt] = await Promise.all([tx.get(invRef), tx.get(cRef)]);
      const d = inv.data();
      if(d.statut === 'valide') return { deja:true, rapportId:d.rapportId, rapportNumero:d.rapportNumero, lignes:d.lignes||[], nbEcarts:d.nbEcarts||0 };
      const annee = aujourdhui().slice(0,4), cle = 'ri_' + annee;
      const n = ((cpt.exists() && Number(cpt.data()[cle])) || 0) + 1;
      const numero = numeroRapport(annee, n);
      const lignes = [...(d.lignes||[])].sort((x,y)=>nomArt(x.articleId).localeCompare(nomArt(y.articleId),'fr'));
      const nbEcarts = lignes.filter(l=>l.ecart).length;
      const rRef = doc(collection(db,'stk_rapportsInventaire'));
      const lignesRap = lignes.map(l => { const a = IDX.articles.get(l.articleId) || {}; return { articleId:l.articleId, ref:a.ref||'', nom:a.nom||'', unite:a.unite||'', cat:a.cat||'', theorique:l.theorique, compte:l.compte, ecart:l.ecart }; });
      tx.set(cRef, { [cle]: n }, { merge:true });
      tx.set(rRef, { numero, inventaireId:_inv._id, lieuId:lieu, lieuNom:nomLieu(lieu), type, dateInventaire:d.date || aujourdhui(), date:aujourdhui(),
        lignes:lignesRap, totaux:totauxRapport(lignesRap, null), creePar:d.creePar||'', validePar:user().name||'', valideParId:user().id||'', genereLe:serverTimestamp() });
      if(estAdmin()) tx.set(doc(db,'stk_rapportsValeurs',rRef.id), valorisation(lignesRap));
      tx.update(invRef, { statut:'valide', nbEcarts, valideLe:serverTimestamp(), validePar:user().name||'', valideParId:user().id||'', date:aujourdhui(), rapportId:rRef.id, rapportNumero:numero });
      return { rapportId:rRef.id, rapportNumero:numero, lignes, nbEcarts };
    });
    const i = STK.inventaires.find(x=>x._id===_inv._id);
    if(i) Object.assign(i, { statut:'valide', nbEcarts:fin.nbEcarts, comptes, lignes:fin.lignes, validePar:user().name||'', date:aujourdhui(), rapportId:fin.rapportId, rapportNumero:fin.rapportNumero });
    notify(`✅ Inventaire validé — ${fin.nbEcarts} écart(s). Rapport ${fin.rapportNumero} créé.`);
    go('rapports');
    await voirRapport(fin.rapportId);
  }catch(e){
    notify(msgErreur(e) + " — relancez « Valider » : la validation reprendra là où elle s'est arrêtée.",'err');
    try{ await chargerTout(); }catch(_){}
  }
});

/* ═══════════════════════════════════════════════════
   RAPPORTS D'INVENTAIRE (enregistrés, imprimables)
   Les quantités sont dans stk_rapportsInventaire (admin + gestionnaire).
   La valorisation est dans stk_rapportsValeurs (admin seulement) : figée
   à la création si l'admin valide, sinon à la première ouverture par l'admin.
═══════════════════════════════════════════════════ */
function valorisation(lignes){
  const prix = {}; lignes.forEach(l => { prix[l.articleId] = prixTmmb(l.articleId); });
  return { prix, totaux:totauxRapport(lignes, prix), valoriseLe:serverTimestamp(), valoriseLeTxt:new Date().toISOString(), valorisePar:user().name||'' };
}
let _rapports = [], _rapOuvert = null;
window.chargerRapports = async function(){
  const du = document.getElementById('rap-du').value, au = document.getElementById('rap-au').value;
  document.getElementById('rap-body').innerHTML = '<tr><td colspan="8" class="emp">Chargement…</td></tr>';
  try{
    const s = await getDocs(query(collection(db,'stk_rapportsInventaire'), where('date','>=',du||'0000'), where('date','<=',au||'9999')));
    _rapports = _docs(s).sort((a,b)=>String(b.numero).localeCompare(String(a.numero)));
    renderRapports();
  }catch(e){ document.getElementById('rap-body').innerHTML = `<tr><td colspan="8" class="emp">${esc(msgErreur(e))}</td></tr>`; }
};
window.renderRapports = function(){
  const t = (document.getElementById('rap-search').value||'').trim().toLowerCase();
  const l = document.getElementById('rap-lieu').value, ty = document.getElementById('rap-type').value;
  const rows = _rapports.filter(r => (!t || String(r.numero).toLowerCase().includes(t)) && (!l || r.lieuId === l) && (!ty || r.type === ty)).map(r => {
    const id = sid(r._id);
    return `<tr><td><span class="ref-tag" style="margin:0;">${esc(r.numero)}</span></td><td>${dateFr(r.date)}</td><td>${lieuHtml(r.lieuId)}</td>
      <td>${r.type==='depart' ? 'Départ' : 'Périodique'}</td><td>${fmtN(r.totaux?.articles)}</td><td>${fmtN(r.totaux?.avecEcart)}</td><td class="muted">${esc(r.validePar||'')}</td>
      <td class="no-print">${id ? `<button class="btn btn-ghost btn-xs" onclick="voirRapport('${id}')">👁️ Voir</button> <button class="btn btn-primary btn-xs" onclick="voirRapport('${id}',true)">🖨️ Imprimer</button>` : ''}</td></tr>`;
  });
  paginer('rap-body', rows, 8, 'Aucun rapport pour ces filtres.');
};
window.voirRapport = async function(id, imprimer){
  try{
    let r = _rapports.find(x => x._id === id);
    if(!r){ const s = await getDoc(doc(db,'stk_rapportsInventaire',id)); if(!s.exists()) return notify('Rapport introuvable','err'); r = { ...s.data(), _id:s.id }; }
    let valeurs = null;
    if(estAdmin()){
      const vRef = doc(db,'stk_rapportsValeurs',id);
      const v = await getDoc(vRef);
      if(v.exists()) valeurs = v.data();
      else { valeurs = valorisation(r.lignes||[]); await setDoc(vRef, valeurs); }   // valorisé à la 1re ouverture par l'admin
    }
    _rapOuvert = { r, valeurs };
    if(curPg !== 'rapports') go('rapports');
    document.getElementById('rap-liste').style.display = 'none';
    document.getElementById('rap-vue').style.display = '';
    document.getElementById('rap-contenu').innerHTML = rapportHtml(r, valeurs);
    if(imprimer) imprimerRapportOuvert();
  }catch(e){ notify(msgErreur(e),'err'); }
};
window.fermerRapport = function(){
  _rapOuvert = null;
  document.getElementById('rap-liste').style.display = '';
  document.getElementById('rap-vue').style.display = 'none';
};
window.imprimerRapportOuvert = function(){
  if(!_rapOuvert) return;
  const z = document.getElementById('print-zone');
  z.innerHTML = rapportHtml(_rapOuvert.r, _rapOuvert.valeurs);
  document.body.classList.add('impression');
  const fin = () => { document.body.classList.remove('impression'); z.innerHTML = ''; window.removeEventListener('afterprint', fin); };
  window.addEventListener('afterprint', fin);
  setTimeout(() => window.print(), 50);
  setTimeout(fin, 60000);   // sécurité si « afterprint » n'arrive pas
};
function rapportHtml(r, valeurs){
  const v = valeurs && valeurs.prix ? valeurs : null;
  const t = r.totaux || {}, tv = v ? (v.totaux || {}) : null;
  const lignes = r.lignes || [];
  const ligne = l => `<tr><td>${esc(l.ref||'')}</td><td>${esc(l.nom||nomArt(l.articleId))}</td><td>${esc(l.unite||'')}</td><td class="n">${fmtN(l.theorique)}</td><td class="n">${fmtN(l.compte)}</td>
    <td class="n ${l.ecart>0?'pos':l.ecart<0?'neg':''}">${l.ecart>0?'+':''}${fmtN(l.ecart)}</td>${v ? `<td class="n">${fmtF(v.prix[l.articleId]||0)}</td><td class="n ${l.ecart>0?'pos':l.ecart<0?'neg':''}">${fmtF(l.ecart*(v.prix[l.articleId]||0))}</td>` : ''}</tr>`;
  const ecarts = lignes.filter(l => l.ecart);
  const imprimeLe = new Date().toLocaleString('fr-FR');
  return `<div class="rap-doc">
    <div class="rap-ruban"></div>
    <div class="rap-entete">
      <div><h1>Rapport d'inventaire</h1><div class="rap-meta"><b>TRIOMPHANT MMB SERVICE</b> — Module Stock</div></div>
      <div style="text-align:right;"><div class="rap-num">${esc(r.numero)}</div><div class="rap-meta">${r.type === 'depart' ? 'Inventaire de départ' : 'Inventaire périodique'}</div></div>
    </div>
    <div class="rap-meta">
      <b>Lieu :</b> ${esc(r.lieuNom || nomLieu(r.lieuId))} · <b>Comptage commencé le :</b> ${dateFr(r.dateInventaire)} · <b>Validé le :</b> ${dateFr(r.date)}<br>
      <b>Commencé par :</b> ${esc(r.creePar||'—')} · <b>Validé par :</b> ${esc(r.validePar||'—')}
    </div>
    <div class="rap-totaux">
      <div>Articles inventoriés<b>${fmtN(t.articles)}</b></div>
      <div>Articles avec écart<b>${fmtN(t.avecEcart)}</b></div>
      <div>Unités en plus<b class="pos">+${fmtN(t.unitesPlus)}</b></div>
      <div>Unités manquantes<b class="neg">−${fmtN(t.unitesMoins)}</b></div>
      ${tv ? `<div>Valeur comptée<b>${fmtF(tv.valeurComptee)}</b></div><div>Valeur des manquants<b class="neg">${fmtF(tv.valeurMoins)}</b></div><div>Valeur des surplus<b class="pos">${fmtF(tv.valeurPlus)}</b></div>` : ''}
    </div>
    ${ecarts.length ? `<h3 style="font-size:13px;margin:14px 0 4px;">Écarts constatés (${ecarts.length})</h3>
    <table><thead><tr><th>Réf.</th><th>Article</th><th>Unité</th><th>Théorique</th><th>Compté</th><th>Écart</th>${v ? '<th>Prix achat</th><th>Valeur écart</th>' : ''}</tr></thead><tbody>${ecarts.map(ligne).join('')}</tbody></table>` : '<p><b>Aucun écart constaté.</b></p>'}
    <h3 style="font-size:13px;margin:14px 0 4px;">Détail complet (${lignes.length} articles)</h3>
    <table><thead><tr><th>Réf.</th><th>Article</th><th>Unité</th><th>Théorique</th><th>Compté</th><th>Écart</th>${v ? '<th>Prix achat</th><th>Valeur écart</th>' : ''}</tr></thead><tbody>${lignes.map(ligne).join('')}</tbody></table>
    <div class="rap-signatures"><div>Le gestionnaire de stock<br><br><br></div><div>L'administrateur<br><br><br></div></div>
    <div class="rap-pied">${v ? `Valorisation au prix d'achat TMMB du ${esc(v.valoriseLeTxt ? new Date(v.valoriseLeTxt).toLocaleDateString('fr-FR') : '')} — document réservé à l'administration. ` : ''}Imprimé le ${esc(imprimeLe)} par ${esc(user().name||'')}.</div>
  </div>`;
}

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
  document.getElementById('liv-averifier-count').textContent = '(' + STK.aVerifier.length + ')';
  paginer('liv-averifier', STK.aVerifier.map(f => {
    const id = sid(f._id);
    const actions = !id ? '' : f.statut === 'annulee_apres_deduction'
      ? `<button class="btn btn-success btn-xs" onclick="reintegrerLivraison('${id}')">↩ Remettre en stock</button> <button class="btn btn-ghost btn-xs" onclick="ignorerLivraison('${id}')">Garder la sortie</button>`
      : `<button class="btn btn-primary btn-xs" onclick="reessayerLivraison('${id}')">🔄 Réessayer</button> <button class="btn btn-ghost btn-xs" onclick="ignorerLivraison('${id}')">Ignorer</button>`;
    return `<tr><td>${dateFr(f.date)}</td><td>${esc(f.produitNom||f.produitId||'')}</td><td>${fmtN(f.qtyLivraison)}</td><td style="font-size:12px;">${esc(f.motif||'')}</td><td class="no-print">${actions}</td></tr>`;
  }), 5, '');
}
let _livRows = [];
window.chargerLivTraitees = async function(){
  const du = document.getElementById('liv-du').value, au = document.getElementById('liv-au').value;
  document.getElementById('liv-body').innerHTML = '<tr><td colspan="6" class="emp">Chargement…</td></tr>';
  try{
    const snap = await getDocs(query(collection(db,'stk_livTraitees'), where('date','>=',du||'0000'), where('date','<=',au||'9999')));
    _livRows = _docs(snap).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    renderLivTraitees();
  }catch(e){ document.getElementById('liv-body').innerHTML = `<tr><td colspan="6" class="emp">${esc(msgErreur(e))}</td></tr>`; }
};
window.renderLivTraitees = function(){
  const ag = document.getElementById('liv-agence').value, st = document.getElementById('liv-statut').value;
  const t = (document.getElementById('liv-search').value||'').trim().toLowerCase();
  const rows = _livRows.filter(f => (st ? f.statut === st : ['deduit','reintegree'].includes(f.statut)) && (!ag || f.agenceId === ag)
      && (!t || String(f.produitNom||'').toLowerCase().includes(t)))
    .map(f => `<tr><td>${dateFr(f.date)}</td><td>${esc(f.produitNom||'')}${f.statut==='reintegree' ? ' <span class="tag tag-warn tag-sm">réintégrée</span>' : f.statut==='ignoree' ? ' <span class="tag-annule">ignorée</span>' : ''}</td><td>${fmtN(f.qtyLivraison)}</td><td>${f.agenceId ? lieuHtml(f.agenceId) : '—'}</td>
      <td style="font-size:12px;">${(f.lignes||[]).map(x=>`${esc(nomArt(x.articleId))} × ${fmtN(x.qty)}`).join('<br>') || esc(f.motif||'')}</td>
      <td class="muted">${f.traiteLe && f.traiteLe.toDate ? f.traiteLe.toDate().toLocaleString('fr-FR') : ''}</td></tr>`);
  paginer('liv-body', rows, 6, 'Aucune livraison pour ces filtres.');
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
   MOUVEMENTS & SYNTHÈSE
═══════════════════════════════════════════════════ */
let _mv = [];
const TYPES = { entree:'Entrée fournisseur', transfert:'Transfert', dispatch:'Dispatch', sortie:'Autre sortie', livraison:'Livraison TMMB', inventaire:'Écart inventaire', reintegration:'Réintégration' };
const typeMv = m => m.type === 'transfert' && m.agenceId === GENERAL ? 'dispatch' : m.type;
window.chargerMouvements = async function(){
  const du = document.getElementById('mv-du').value, au = document.getElementById('mv-au').value;
  if(!du || !au || du > au) return notify('Période invalide','err');
  document.getElementById('mv-body').innerHTML = '<tr><td colspan="7" class="emp">Chargement…</td></tr>';
  try{
    const snap = await getDocs(query(collection(db,'stk_mouvements'), where('date','>=',du), where('date','<=',au)));
    _mv = _docs(snap).sort((a,b)=>String(b.date).localeCompare(String(a.date)) || ((b.ts?.seconds||0)-(a.ts?.seconds||0)));
    _mv.forEach(m => _histoMv.set(m._id, m));
    renderMouvements();
  }catch(e){ document.getElementById('mv-body').innerHTML = `<tr><td colspan="7" class="emp">${esc(msgErreur(e))}</td></tr>`; }
};
['mv-lieu','mv-type','mv-cat','mv-statut'].forEach(id => document.getElementById(id).addEventListener('change', ()=>renderMouvements()));
document.getElementById('mv-search').addEventListener('input', ()=>renderMouvements());
function mouvementsFiltres(){
  const lieu = document.getElementById('mv-lieu').value, ty = document.getElementById('mv-type').value;
  const cat = document.getElementById('mv-cat').value, st = document.getElementById('mv-statut').value;
  const t = (document.getElementById('mv-search').value||'').trim().toLowerCase();
  return _mv.filter(m => {
    if(st === 'actifs' && m.annule) return false;
    if(st === 'annules' && !m.annule) return false;
    if(ty && !(ty === typeMv(m) || (ty === 'transfert' && m.type === 'transfert'))) return false;
    if(lieu && m.agenceId !== lieu && m.agenceDestId !== lieu) return false;
    const a = IDX.articles.get(m.articleId) || {};
    if(cat && a.cat !== cat) return false;
    if(t && !String(a.nom||'').toLowerCase().includes(t) && !String(a.ref||'').toLowerCase().includes(t)) return false;
    return true;
  });
}
function renderMouvements(){
  const admin = estAdmin();
  const lieu = document.getElementById('mv-lieu').value;
  const mv = mouvementsFiltres();
  document.getElementById('mv-count').textContent = '(' + mv.length + ')';
  paginer('mv-body', mv.map(m => {
    let qtxt = fmtN(qteAffichee(m)), det = '', sens = '';
    if(m.type === 'transfert'){ det = `${lieuHtml(m.agenceId)} → ${lieuHtml(m.agenceDestId)}`; if(lieu) sens = m.agenceId === lieu ? '−' : '+'; }
    else { sens = Number(m.qty) < 0 ? '−' : '+'; }
    if(m.type === 'entree') det = esc(m.fournisseur||'') + (m.ref ? ' · ' + esc(m.ref) : '');
    else if(m.type === 'sortie') det = esc(MOTIFS_SORTIE[m.motifSortie] || '');
    else if(m.type === 'livraison') det = esc(m.produitNom||'');
    else if(m.type === 'inventaire') det = (m.inventaireType === 'depart' ? 'Inventaire de départ · ' : '') + `théorique ${fmtN(m.theorique)} → compté ${fmtN(m.compte)}`;
    const tags = (m.annule ? ' <span class="tag-annule">annulé</span>' : '') + (Array.isArray(m.historique) && m.historique.some(h=>h.action==='correction') ? ' <span class="tag-modifie">modifié</span>' : '');
    return `<tr class="${m.annule ? 'op-annulee' : ''}"><td>${dateFr(m.date)}</td><td>${esc(TYPES[typeMv(m)]||m.type)}${tags}</td><td class="op-txt">${esc(nomArt(m.articleId))}</td><td>${m.type==='transfert' ? '' : lieuHtml(m.agenceId)}</td>
      <td class="${sens==='−' ? 'ecart-neg' : ''}">${sens}${qtxt}</td><td style="font-size:12px;">${det}${m.note ? ' · ' + esc(m.note) : ''}</td><td class="muted">${esc(m.auteurNom||'')}</td></tr>`;
  }), 7, 'Aucun mouvement pour ces filtres.');

  const syn = syntheseMouvements(mv, lieu);
  document.getElementById('mv-synthese-head').innerHTML = `<tr><th>Article</th><th>Départ</th><th>Entrées</th><th>Reçus</th><th>Envoyés</th><th>Sorties</th><th>Livraisons</th><th>Écarts inv.</th><th>Variation</th><th>Stock actuel</th>${admin ? '<th>Valeur actuelle</th>' : ''}</tr>`;
  let tE=0, tS=0, tL=0, tI=0;
  const rows = articlesTries().filter(a => syn.has(a._id)).map(a => {
    const r = syn.get(a._id);
    const st = lieu ? qte(lieu, a._id) : stockTotal(a._id);
    tE += r.entrees; tS += r.sorties; tL += r.livraisons; tI += r.inventaire;
    const n = v => v ? fmtN(v) : '<span class="muted">—</span>';
    return `<tr><td>${esc(a.nom)} ${refTag(a)}</td><td>${n(r.depart)}</td><td>${n(r.entrees)}</td><td>${lieu ? n(r.recus) : '—'}</td><td>${lieu ? n(r.envoyes) : '—'}</td><td>${n(r.sorties)}</td><td>${n(r.livraisons)}</td>
      <td class="${r.inventaire>0?'ecart-pos':r.inventaire<0?'ecart-neg':''}">${r.inventaire>0?'+':''}${n(r.inventaire)}</td><td style="font-weight:700;">${r.variation>0?'+':''}${fmtN(r.variation)}</td><td>${fmtN(st)}</td>${admin ? `<td>${fmtF(Math.max(0,st)*prixTmmb(a._id))}</td>` : ''}</tr>`;
  });
  paginer('mv-synthese', rows, admin ? 11 : 10, 'Aucun mouvement.');
  document.getElementById('mv-kpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-lbl">Unités entrées</div><div class="kpi-val kv-green">${fmtN(tE)}</div><div class="kpi-sub">entrées fournisseurs</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Unités livrées</div><div class="kpi-val kv-blue">${fmtN(tL)}</div><div class="kpi-sub">livraisons TMMB</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Autres sorties</div><div class="kpi-val kv-yellow">${fmtN(tS)}</div><div class="kpi-sub">pertes, usage…</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Écarts d'inventaire</div><div class="kpi-val ${tI<0?'kv-red':'kv-green'}">${tI>0?'+':''}${fmtN(tI)}</div><div class="kpi-sub">hors inventaire de départ</div></div>`;
}
window.exportMouvementsCsv = function(){
  const rows = [['Date','Type','Annulé','Référence article','Article','Catégorie','Lieu','Lieu arrivée','Quantité','Fournisseur','N° facture','Motif sortie','Produit livré','Théorique','Compté','Note','Par']];
  for(const m of mouvementsFiltres()){
    const a = IDX.articles.get(m.articleId) || {};
    rows.push([m.date, TYPES[typeMv(m)]||m.type, m.annule ? 'oui' : '', a.ref||'', a.nom||m.articleId, a.cat||'', nomLieu(m.agenceId), m.agenceDestId ? nomLieu(m.agenceDestId) : '',
      m.type === 'transfert' ? m.qty : m.qty, m.fournisseur||'', m.ref||'', MOTIFS_SORTIE[m.motifSortie]||'', m.produitNom||'', m.theorique ?? '', m.compte ?? '', m.note||'', m.auteurNom||'']);
  }
  telechargerCsv('mouvements_' + document.getElementById('mv-du').value + '_' + document.getElementById('mv-au').value + '.csv', rows);
};

/* ═══════════════════════════════════════════════════
   ACHATS & VALEURS (administrateur)
═══════════════════════════════════════════════════ */
let _va = [];
window.chargerValeurs = async function(){
  if(!estAdmin()) return;
  const du = document.getElementById('va-du').value, au = document.getElementById('va-au').value;
  if(!du || !au || du > au) return notify('Période invalide','err');
  document.getElementById('va-body').innerHTML = '<tr><td colspan="8" class="emp">Chargement…</td></tr>';
  try{
    const s = await getDocs(query(collection(db,'stk_prixEntrees'), where('date','>=',du), where('date','<=',au)));
    _va = _docs(s).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    _va.forEach(p => _prixMap.set(p._id, p));
    renderValeurs();
  }catch(e){ document.getElementById('va-body').innerHTML = `<tr><td colspan="8" class="emp">${esc(msgErreur(e))}</td></tr>`; }
};
function valeursFiltrees(){
  const f = (document.getElementById('va-fourn').value||'').trim().toLowerCase(), t = (document.getElementById('va-search').value||'').trim().toLowerCase();
  const e = document.getElementById('va-etat').value;
  return _va.map(p => _prixMap.get(p._id) || p).filter(p => {
    if(e === 'annule' ? !p.annule : p.annule) return false;
    if(e === 'zero' && Number(p.prixAchat)) return false;
    if(e === 'corrige' && !(Array.isArray(p.corrections) && p.corrections.length)) return false;
    if(f && !String(p.fournisseur||'').toLowerCase().includes(f) && !String(p.ref||'').toLowerCase().includes(f)) return false;
    const a = IDX.articles.get(p.articleId) || {};
    if(t && !String(a.nom||'').toLowerCase().includes(t) && !String(a.ref||'').toLowerCase().includes(t)) return false;
    return true;
  });
}
window.renderValeurs = function(){
  if(!estAdmin()) return;
  const lignes = valeursFiltrees();
  let total = 0, zero = 0;
  const rows = lignes.map(p => {
    const mt = (Number(p.qty)||0) * (Number(p.prixAchat)||0); if(!p.annule) total += mt; if(!Number(p.prixAchat)) zero++;
    const id = sid(p._id);
    const tags = (p.annule ? ' <span class="tag-annule">annulée</span>' : '') + (Array.isArray(p.corrections) && p.corrections.length ? ` <span class="tag-corrige" title="Prix d'origine : ${esc(fmtF(p.corrections[0].ancien))}">corrigé</span>` : '') + (!Number(p.prixAchat) ? ' <span class="tag-annule">prix à 0</span>' : '');
    return `<tr class="${p.annule ? 'op-annulee' : ''}"><td>${dateFr(p.date)}</td><td>${esc(p.fournisseur||'')}</td><td class="muted">${esc(p.ref||'')}</td><td class="op-txt">${esc(nomArt(p.articleId))}${tags}</td><td>${fmtN(p.qty)}</td><td>${fmtF(p.prixAchat)}</td><td style="font-weight:700;">${fmtF(mt)}</td>
      <td class="no-print">${id && !p.annule ? `<button class="btn btn-ghost btn-xs" onclick="ouvrirCorrectionPrix('${id}')">💲 Prix</button>` : ''}</td></tr>`;
  });
  paginer('va-body', rows, 8, 'Aucune ligne pour ces filtres.');
  document.getElementById('va-count').textContent = '(' + lignes.length + ')';
  let vTot = 0;
  const lieuxRows = lieux().map(l => {
    let u = 0, v = 0; for(const a of TDB.articles){ const q = qte(l._id, a._id); u += q; v += Math.max(0,q) * prixTmmb(a._id); }
    vTot += v;
    return `<tr><td>${lieuHtml(l._id)}</td><td>${fmtN(u)}</td><td style="font-weight:700;">${fmtF(v)}</td></tr>`;
  });
  document.getElementById('va-lieux').innerHTML = lieuxRows.join('') + `<tr class="st-total"><td>TOTAL</td><td></td><td>${fmtF(vTot)}</td></tr>`;
  document.getElementById('va-kpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-lbl">Achats affichés</div><div class="kpi-val kv-purple">${fmtF(total)}</div><div class="kpi-sub">hors lignes annulées</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Lignes d'achat</div><div class="kpi-val kv-blue">${fmtN(lignes.length)}</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Prix à 0</div><div class="kpi-val ${zero?'kv-red':'kv-green'}">${zero}</div><div class="kpi-sub">article sans prix d'achat dans TMMB</div></div>
    <div class="kpi-card"><div class="kpi-lbl">Valeur du stock</div><div class="kpi-val kv-green">${fmtF(vTot)}</div><div class="kpi-sub">tous lieux, prix TMMB actuel</div></div>`;
};
window.exportValeursCsv = function(){
  if(!estAdmin()) return;
  const rows = [['Date','Fournisseur','N° facture','Référence article','Article','Quantité',"Prix d'achat","Prix d'origine (si corrigé)",'Montant','Annulée']];
  for(const p of valeursFiltrees()){
    const a = IDX.articles.get(p.articleId) || {};
    rows.push([p.date, p.fournisseur||'', p.ref||'', a.ref||'', a.nom||p.articleId, p.qty, p.prixAchat, (Array.isArray(p.corrections) && p.corrections.length) ? p.corrections[0].ancien : '', (Number(p.qty)||0)*(Number(p.prixAchat)||0), p.annule ? 'oui' : '']);
  }
  telechargerCsv('achats_' + document.getElementById('va-du').value + '_' + document.getElementById('va-au').value + '.csv', rows);
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
    : `Fixer le jour J au ${dateFr(d)} ?\n\nToutes les livraisons TMMB livrées datées de ce jour ou après seront déduites du stock des agences.`;
  if(!confirm(msg)) return;
  try{
    await setDoc(doc(db,'stk_config','reglages'), { jourJ:d, majLe:serverTimestamp(), majPar:user().name||'' }, { merge:true });
    STK.jourJ = d; majBandeau(); notify('✅ Jour J enregistré');
    relireLivraisons(true);
  }catch(e){ notify(msgErreur(e),'err'); }
};
