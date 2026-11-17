// Tests des règles de calcul : node tests/test-logic.mjs
import assert from 'node:assert/strict';
import { analyserLivraison, syntheseMouvements, calculInventaire, agenceLivraison, quantiteValide, compteValide, cleStock } from '../stock-logic.js';

let n = 0; const t = (nom, f) => { f(); n++; console.log('  ✔', nom); };
const articles = new Map([['A1',{nom:'Matelas'}],['A2',{nom:'Oreiller'}]]);
const commerciaux = new Map([['C1',{agenceId:'AG1'}],['C2',{agenceId:'AG2'}]]);
const produits = new Map([['P1',{nom:'Kit',composition:[{articleId:'A1',qte:1},{articleId:'A2',qte:2}]}]]);
const ctx = (o={}) => ({ jourJ:'2026-11-20', client:{agenceId:'AG1'}, commerciauxById:commerciaux, produitsById:produits, articlesById:articles, ...o });
const liv = (o={}) => ({ date:'2026-11-21', statut:'livre', qty:3, produitId:'P1', clientId:'X', commercialId:'C2', ...o });

t('livraison avant le jour J ignorée', () => assert.equal(analyserLivraison(liv({date:'2026-11-19'}), ctx()).action, 'hors_periode'));
t('livraison du jour J prise en compte', () => assert.equal(analyserLivraison(liv({date:'2026-11-20'}), ctx()).action, 'deduire'));
t('en attente / annulée = non livrée', () => { assert.equal(analyserLivraison(liv({statut:'en_attente'}), ctx()).action, 'non_livree'); assert.equal(analyserLivraison(liv({statut:'annule'}), ctx()).action, 'non_livree'); });
t('« livré » avec accent accepté', () => assert.equal(analyserLivraison(liv({statut:'livré'}), ctx()).action, 'deduire'));
t('livraison partielle → à vérifier', () => assert.equal(analyserLivraison(liv({statut:'livre_partiel'}), ctx()).action, 'a_verifier'));
t('quantités = composition × quantité livrée', () => {
  const r = analyserLivraison(liv(), ctx());
  assert.equal(r.agenceId, 'AG1');
  assert.deepEqual(r.lignes.map(l=>[l.articleId,l.qty]), [['A1',3],['A2',6]]);
});
t('composition figée prioritaire sur le produit actuel', () => {
  const r = analyserLivraison(liv({compositionFigee:[{articleId:'A2',qte:1}]}), ctx());
  assert.deepEqual(r.lignes.map(l=>[l.articleId,l.qty]), [['A2',3]]);
});
t('même article deux fois dans la composition : additionné', () => {
  const r = analyserLivraison(liv({qty:2, compositionFigee:[{articleId:'A1',qte:1},{articleId:'A1',qte:2}]}), ctx());
  assert.deepEqual(r.lignes.map(l=>[l.articleId,l.qty]), [['A1',6]]);
});
t('agence : client, puis commercial du client, puis commercial de la livraison', () => {
  assert.equal(agenceLivraison({agenceId:'AG9'}, liv(), commerciaux), 'AG9');
  assert.equal(agenceLivraison({agenceId:'', commercialId:'C1'}, liv(), commerciaux), 'AG1');
  assert.equal(agenceLivraison(null, liv(), commerciaux), 'AG2');
});
t('sans agence → à vérifier', () => assert.equal(analyserLivraison(liv({commercialId:'??'}), ctx({client:null})).action, 'a_verifier'));
t('article inconnu → à vérifier (rien de déduit)', () => { const r = analyserLivraison(liv({compositionFigee:[{articleId:'ZZ',qte:1}]}), ctx()); assert.equal(r.action, 'a_verifier'); assert.equal(r.lignes, undefined); });
t('sans composition → à vérifier', () => assert.equal(analyserLivraison(liv({produitId:'P9'}), ctx()).action, 'a_verifier'));
t('quantité invalide → à vérifier', () => { assert.equal(analyserLivraison(liv({qty:0}), ctx()).action, 'a_verifier'); assert.equal(analyserLivraison(liv({qty:'x'}), ctx()).action, 'a_verifier'); });
t('jour J vide → rien', () => assert.equal(analyserLivraison(liv(), ctx({jourJ:''})).action, 'hors_periode'));

const mv = [
  {type:'entree', articleId:'A1', agenceId:'AG1', qty:10, prixAchat:500},
  {type:'transfert', articleId:'A1', agenceId:'AG1', agenceDestId:'AG2', qty:4},
  {type:'livraison', articleId:'A1', agenceId:'AG2', qty:-1},
  {type:'inventaire', articleId:'A1', agenceId:'AG1', qty:-2},
  {type:'inventaire', inventaireType:'depart', articleId:'A1', agenceId:'AG1', qty:7},
  {type:'reintegration', articleId:'A1', agenceId:'AG2', qty:1},
];
t('synthèse agence de départ', () => { const r = syntheseMouvements(mv,'AG1').get('A1'); assert.equal(r.entrees,10); assert.equal(r.envoyes,4); assert.equal(r.inventaire,-2); assert.equal(r.depart,7); assert.equal(r.variation,11); assert.equal(r.valeurEntrees,5000); });
t('synthèse agence d\'arrivée', () => { const r = syntheseMouvements(mv,'AG2').get('A1'); assert.equal(r.recus,4); assert.equal(r.livraisons,1); assert.equal(r.reintegration,1); assert.equal(r.variation,4); });
t('toutes agences : les transferts s\'annulent', () => { const r = syntheseMouvements(mv,'').get('A1'); assert.equal(r.recus,0); assert.equal(r.envoyes,0); assert.equal(r.variation, 7+10-1-2+1); });

const stock = {A1:5, A2:3};
t('inventaire de départ : case vide = 0', () => {
  const r = calculInventaire(['A1','A2'], {A1:7}, id=>stock[id], 'depart');
  assert.deepEqual(r.map(l=>[l.articleId,l.compte,l.ecart]), [['A1',7,2],['A2',0,-3]]);
});
t('inventaire périodique : case vide = non compté', () => {
  const r = calculInventaire(['A1','A2'], {A1:'4'}, id=>stock[id], 'periodique');
  assert.deepEqual(r.map(l=>[l.articleId,l.compte,l.ecart]), [['A1',4,-1]]);
});
t('compté = 0 explicitement est retenu', () => assert.equal(calculInventaire(['A2'], {A2:0}, id=>stock[id], 'periodique').length, 1));
t('validations de saisie', () => {
  assert.ok(quantiteValide('3')); assert.ok(!quantiteValide('0')); assert.ok(!quantiteValide('2.5')); assert.ok(!quantiteValide('-1')); assert.ok(!quantiteValide('abc'));
  assert.ok(compteValide('0')); assert.ok(!compteValide('-2'));
});
t('clé de stock', () => assert.equal(cleStock('AG1','A1'), 'AG1__A1'));
console.log(`\n${n} tests OK`);
