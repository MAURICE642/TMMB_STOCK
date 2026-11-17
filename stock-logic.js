/* ═══════════════════════════════════════════════════
   TRIOMPHANT — STOCK · règles de calcul (sans Firebase)
   Fonctions pures : elles ne lisent ni n'écrivent rien en base.
   Testées à part : node tests/test-logic.mjs
═══════════════════════════════════════════════════ */

// Le stock général est un « lieu » comme les agences, avec un identifiant réservé.
export const GENERAL = 'STOCK_GENERAL';

// Statuts TMMB d'une livraison effectivement remise au client.
export const STATUTS_LIVRES = ['livre', 'livré'];
export function estLivree(statut){ return STATUTS_LIVRES.includes(statut); }

// Motifs des « autres sorties ».
export const MOTIFS_SORTIE = {
  perte:'Perte / casse', usage:'Usage interne', retour_fournisseur:'Retour fournisseur',
  don:'Don / échantillon', autre:'Autre'
};

// Types d'opérations que l'administrateur peut corriger ou annuler.
export const TYPES_CORRIGEABLES = ['entree', 'transfert', 'sortie'];

// Identifiant du document stk_stock d'un couple lieu / article.
export function cleStock(lieuId, articleId){ return lieuId + '__' + articleId; }

// Agence d'une livraison : même ordre que TMMB (_agenceLivraison, volet 54).
export function agenceLivraison(client, l, commerciauxById){
  const agCom = id => (id && commerciauxById.get(id) && commerciauxById.get(id).agenceId) || null;
  return (client && client.agenceId) || agCom(client && client.commercialId) || agCom(l && l.commercialId) || null;
}

// Composition à déduire : celle figée sur la livraison, sinon celle du produit actuel.
export function compositionLivraison(l, produitsById){
  if(l && Array.isArray(l.compositionFigee) && l.compositionFigee.length) return l.compositionFigee;
  const p = l && produitsById.get(l.produitId);
  return (p && Array.isArray(p.composition)) ? p.composition : [];
}

/* Décide quoi faire d'une livraison TMMB → { action, agenceId, lignes, motif }
   'hors_periode' | 'non_livree' | 'a_verifier' | 'deduire' */
export function analyserLivraison(l, ctx){
  const { jourJ, client, commerciauxById, produitsById, articlesById } = ctx;
  if(!l || !l.date || !jourJ || l.date < jourJ) return { action:'hors_periode' };
  if(l.statut === 'livre_partiel') return { action:'a_verifier', motif:'Livraison partielle : quantité réellement livrée inconnue' };
  if(!estLivree(l.statut)) return { action:'non_livree' };
  const q = Number(l.qty);
  if(!(q > 0)) return { action:'a_verifier', motif:'Quantité livrée invalide (' + String(l.qty) + ')' };
  const comp = compositionLivraison(l, produitsById);
  if(!comp.length) return { action:'a_verifier', motif:"Le produit n'a pas de composition d'articles" };
  const agenceId = agenceLivraison(client, l, commerciauxById);
  if(!agenceId) return { action:'a_verifier', motif:"Agence introuvable (ni le client ni son commercial n'ont d'agence)" };
  const parArticle = new Map();
  for(const c of comp){
    const art = articlesById.get(c && c.articleId);
    if(!art) return { action:'a_verifier', agenceId, motif:'Article inconnu dans la composition : ' + String((c && (c.nom || c.articleId)) || '?') };
    const n = Number(c.qte) * q;
    if(!(n > 0)) return { action:'a_verifier', agenceId, motif:'Quantité de composant invalide pour « ' + (art.nom || c.articleId) + ' »' };
    parArticle.set(c.articleId, (parArticle.get(c.articleId) || 0) + n);
  }
  const lignes = [...parArticle].map(([articleId, qty]) => ({ articleId, nom: articlesById.get(articleId).nom || '', qty }));
  return { action:'deduire', agenceId, lignes };
}

/* Effet d'un mouvement sur le stock : [{ lieu, delta }]
   - transfert : qty > 0, sort de agenceId, entre dans agenceDestId ;
   - les autres : qty est déjà signé (entrée +, sortie −, livraison −, inventaire ±, réintégration +). */
export function effetsMouvement(m){
  const q = Number(m.qty) || 0;
  if(m.type === 'transfert') return [{ lieu:m.agenceId, delta:-q }, { lieu:m.agenceDestId, delta:q }];
  return [{ lieu:m.agenceId, delta:q }];
}

/* Corriger la quantité d'une opération : ce qu'il faut ajouter au stock.
   nouvelleQty est la quantité saisie par l'admin, toujours POSITIVE (comme à l'écran). */
export function deltasCorrection(m, nouvelleQty){
  const n = Number(nouvelleQty);
  const signe = m.type === 'sortie' ? -1 : 1;
  const nouveau = { ...m, qty: signe * n };
  const avant = new Map(), apres = new Map();
  for(const e of effetsMouvement(m)) avant.set(e.lieu, (avant.get(e.lieu)||0) + e.delta);
  for(const e of effetsMouvement(nouveau)) apres.set(e.lieu, (apres.get(e.lieu)||0) + e.delta);
  const lieux = new Set([...avant.keys(), ...apres.keys()]);
  return { qtyStockee: signe * n, deltas: [...lieux].map(l => ({ lieu:l, delta:(apres.get(l)||0) - (avant.get(l)||0) })).filter(d => d.delta) };
}

// Annuler une opération : l'inverse exact de son effet.
export function deltasAnnulation(m){
  return effetsMouvement(m).map(e => ({ lieu:e.lieu, delta:-e.delta })).filter(d => d.delta);
}

// Quantité affichée (toujours positive pour les entrées, sorties et transferts).
export function qteAffichee(m){ return Math.abs(Number(m.qty) || 0); }

/* Synthèse des mouvements par article pour un lieu ('' = tous les lieux).
   Les mouvements annulés sont ignorés. Les transferts s'annulent quand on regarde tous les lieux. */
export function syntheseMouvements(mvts, lieuFiltre){
  const res = new Map();
  const ligne = id => {
    if(!res.has(id)) res.set(id, { depart:0, entrees:0, recus:0, envoyes:0, sorties:0, livraisons:0, inventaire:0, reintegration:0 });
    return res.get(id);
  };
  for(const m of mvts){
    if(m.annule) continue;
    const q = Number(m.qty) || 0;
    if(m.type === 'transfert'){
      if(!lieuFiltre){ ligne(m.articleId); continue; }
      if(m.agenceId === lieuFiltre) ligne(m.articleId).envoyes += q;
      if(m.agenceDestId === lieuFiltre) ligne(m.articleId).recus += q;
      continue;
    }
    if(lieuFiltre && m.agenceId !== lieuFiltre) continue;
    const r = ligne(m.articleId);
    if(m.type === 'entree') r.entrees += q;
    else if(m.type === 'sortie') r.sorties += -q;
    else if(m.type === 'livraison') r.livraisons += -q;
    else if(m.type === 'inventaire'){ if(m.inventaireType === 'depart') r.depart += q; else r.inventaire += q; }
    else if(m.type === 'reintegration') r.reintegration += q;
  }
  for(const r of res.values()){
    r.variation = r.depart + r.entrees + r.recus - r.envoyes - r.sorties - r.livraisons + r.inventaire + r.reintegration;
  }
  return res;
}

/* Calcul d'un inventaire.
   type 'depart' : case vide = 0 ; 'periodique' : case vide = non compté. */
export function calculInventaire(articleIds, comptes, stockDe, type){
  const out = [];
  for(const id of articleIds){
    const saisi = Object.prototype.hasOwnProperty.call(comptes, id) && comptes[id] !== '' && comptes[id] != null;
    if(!saisi && type !== 'depart') continue;
    const compte = saisi ? Number(comptes[id]) : 0;
    const theorique = Number(stockDe(id)) || 0;
    out.push({ articleId:id, theorique, compte, ecart: compte - theorique });
  }
  return out;
}

// Totaux d'un rapport d'inventaire (prix : articleId → prix unitaire, admin seulement).
export function totauxRapport(lignes, prix){
  const t = { articles:lignes.length, avecEcart:0, unitesPlus:0, unitesMoins:0, valeurPlus:0, valeurMoins:0, valeurComptee:0 };
  for(const l of lignes){
    const p = prix ? (Number(prix.get ? prix.get(l.articleId) : prix[l.articleId]) || 0) : 0;
    if(l.ecart) t.avecEcart++;
    if(l.ecart > 0){ t.unitesPlus += l.ecart; t.valeurPlus += l.ecart * p; }
    if(l.ecart < 0){ t.unitesMoins += -l.ecart; t.valeurMoins += -l.ecart * p; }
    t.valeurComptee += Math.max(0, l.compte) * p;
  }
  return t;
}

// Numéro de rapport : RI-2026-0007
export function numeroRapport(annee, n){ return 'RI-' + annee + '-' + String(n).padStart(4, '0'); }

export function quantiteValide(v){ const n = Number(v); return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 1e7; }
export function compteValide(v){ const n = Number(v); return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 1e7; }
export function prixValide(v){ const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1e10; }
