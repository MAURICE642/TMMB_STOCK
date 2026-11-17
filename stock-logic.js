/* ═══════════════════════════════════════════════════
   TRIOMPHANT — STOCK · règles de calcul (sans Firebase)
   Fonctions pures : elles ne lisent ni n'écrivent rien en base.
   Elles sont testées à part (voir tests/test-logic.mjs).
═══════════════════════════════════════════════════ */

// Statuts TMMB d'une livraison effectivement remise au client.
export const STATUTS_LIVRES = ['livre', 'livré'];

export function estLivree(statut){ return STATUTS_LIVRES.includes(statut); }

// Identifiant du document stk_stock d'un couple agence / article.
export function cleStock(agenceId, articleId){ return agenceId + '__' + articleId; }

// Agence d'une livraison : même ordre que TMMB (_agenceLivraison, volet 54) :
// agence du client, puis agence du commercial du client, puis agence du
// commercial enregistré sur la livraison.
export function agenceLivraison(client, l, commerciauxById){
  const agCom = id => (id && commerciauxById.get(id) && commerciauxById.get(id).agenceId) || null;
  return (client && client.agenceId) || agCom(client && client.commercialId) || agCom(l && l.commercialId) || null;
}

// Composition à déduire : celle figée sur la livraison (volet 17 de TMMB),
// sinon celle du produit actuel.
export function compositionLivraison(l, produitsById){
  if(l && Array.isArray(l.compositionFigee) && l.compositionFigee.length) return l.compositionFigee;
  const p = l && produitsById.get(l.produitId);
  return (p && Array.isArray(p.composition)) ? p.composition : [];
}

/* Décide quoi faire d'une livraison TMMB.
   Renvoie { action, agenceId, lignes, motif }
   action :
     'hors_periode' : datée avant le jour J → jamais prise en compte
     'non_livree'   : pas (ou plus) livrée → à comparer avec ce qui a déjà été déduit
     'a_verifier'   : livrée mais impossible à déduire correctement (motif)
     'deduire'      : lignes = [{articleId, nom, qty}] à retirer du stock de agenceId */
export function analyserLivraison(l, ctx){
  const { jourJ, client, commerciauxById, produitsById, articlesById } = ctx;
  if(!l || !l.date || !jourJ || l.date < jourJ) return { action:'hors_periode' };
  if(l.statut === 'livre_partiel'){
    return { action:'a_verifier', motif:'Livraison partielle : quantité réellement livrée inconnue' };
  }
  if(!estLivree(l.statut)) return { action:'non_livree' };
  const q = Number(l.qty);
  if(!(q > 0)) return { action:'a_verifier', motif:'Quantité livrée invalide (' + String(l.qty) + ')' };
  const comp = compositionLivraison(l, produitsById);
  if(!comp.length) return { action:'a_verifier', motif:"Le produit n'a pas de composition d'articles" };
  const agenceId = agenceLivraison(client, l, commerciauxById);
  if(!agenceId) return { action:'a_verifier', motif:'Agence introuvable (ni le client ni son commercial n\'ont d\'agence)' };
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

/* Synthèse des mouvements par article, pour une agence ('' = toutes).
   Les transferts entre deux agences s'annulent quand on regarde toutes les agences. */
export function syntheseMouvements(mvts, agenceFiltre){
  const res = new Map();
  const ligne = id => {
    if(!res.has(id)) res.set(id, { depart:0, entrees:0, recus:0, envoyes:0, livraisons:0, inventaire:0, reintegration:0, valeurEntrees:0 });
    return res.get(id);
  };
  for(const m of mvts){
    const q = Number(m.qty) || 0;
    if(m.type === 'transfert'){
      if(!agenceFiltre){ ligne(m.articleId); continue; }
      if(m.agenceId === agenceFiltre) ligne(m.articleId).envoyes += q;
      if(m.agenceDestId === agenceFiltre) ligne(m.articleId).recus += q;
      continue;
    }
    if(agenceFiltre && m.agenceId !== agenceFiltre) continue;
    const r = ligne(m.articleId);
    if(m.type === 'entree'){ r.entrees += q; r.valeurEntrees += q * (Number(m.prixAchat) || 0); }
    else if(m.type === 'livraison') r.livraisons += -q;        // q est négatif : on affiche la quantité sortie
    else if(m.type === 'inventaire'){ if(m.inventaireType === 'depart') r.depart += q; else r.inventaire += q; }
    else if(m.type === 'reintegration') r.reintegration += q;
  }
  for(const r of res.values()){
    r.variation = r.depart + r.entrees + r.recus - r.envoyes - r.livraisons + r.inventaire + r.reintegration;
  }
  return res;
}

/* Calcul d'un inventaire.
   comptes   : { articleId: quantité comptée } (seulement les cases remplies)
   stockDe   : fonction articleId → stock théorique actuel
   type      : 'depart' (case vide = 0) ou 'periodique' (case vide = non compté)
   Renvoie [{ articleId, theorique, compte, ecart }] pour les articles retenus. */
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

// Entier positif (quantité saisie).
export function quantiteValide(v){
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 1e7;
}
// Entier positif ou nul (stock compté).
export function compteValide(v){
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 1e7;
}
// Prix positif ou nul.
export function prixValide(v){
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1e10;
}
