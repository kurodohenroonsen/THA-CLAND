# ✨ Améliorations fonctionnelles & UI — P2P Mesh Workspace

Cette itération ajoute une couche d'ergonomie et de fonctionnalités par-dessus les correctifs
de sécurité/robustesse du rapport d'audit. Tout est cohérent avec le design system existant
(thème sombre glassmorphism, variables CSS, composants `.btn`/`.badge`/`.modal`).

## 🎨 Interface (UI/UX)

**Modales accessibles.** Fermeture par **Échap** et par **clic sur l'arrière-plan**, focus
automatique sur le premier champ, restauration du focus à la fermeture (`ui/modal.js`).

**Onglet persistant.** Le dernier onglet consulté est mémorisé et rouvert au démarrage.

**Qualité de connexion.** Nouvel indicateur coloré dans la barre d'état
(Excellente / Bonne / Moyenne / Faible) calculé à partir de la latence RTT moyenne.

**Feuille de style dédiée** `css/enhancements.css` (aucune régression sur l'existant).

## 🔐 Écran d'accueil

- **Jauge d'entropie en temps réel** du code papier (faible / moyenne / forte + estimation en bits).
- **Afficher/masquer** le code (champ masqué par défaut, œil de bascule).
- **Copie avec retour visuel** (« ✓ Copié ! »).
- Nouveau format de code plus robuste pré-rempli dans le placeholder.

## 💬 Chat

- **Saisie multiligne** : textarea auto-extensible, **Entrée** = envoyer, **Maj+Entrée** = nouvelle ligne.
- **Barre d'emojis** rapide (insertion à la position du curseur).
- **Badges de messages non lus** par canal (compteur rouge, remis à zéro à l'ouverture du canal).
- **Pastille « nouveaux messages ↓ »** quand on lit plus haut dans l'historique.
- **Séparateurs de jour** (Aujourd'hui / Hier / date) entre les messages.
- **Notifications bureau** optionnelles pour les nouveaux messages quand la fenêtre est masquée.
- Bouton d'envoi compact (➤) et déduplication O(1) des messages entrants.

## ⚙️ Réglages & Profil (nouveau panneau, ⚙️ dans l'en-tête)

- **Changer de pseudonyme** (mise à jour propagée aux pairs, roster rafraîchi).
- **Empreinte d'identité** (dérivée de la clé publique) et avatar.
- **Copier** le Topic du salon et le code papier.
- **Bascule des notifications** bureau (demande la permission navigateur).
- **Jauge de stockage** utilisé / quota.
- **Déconnexion** propre (arrêt du réseau + effacement de la session locale).

## 📁 Drive

- **Jauge d'espace de stockage** local (usage / quota) en tête du Drive.
- **Nombre de « sources »** (seeders) par fichier, sondé en direct sur le maillage, avec statut de
  **réplication locale** (répliqué ✓ / % local).
- **Aperçu image** intégré (modale) pour les fichiers image, via téléchargement P2P.
- **Suppression de fichier** signée (tombstone répliqué) : le fichier disparaît chez tous les pairs
  et n'est plus listé ; l'opération est authentifiée (signature ECDSA vérifiée à la réception).

## 🔎 Vérification

Contrôle syntaxique de tous les fichiers JS, résolution du graphe d'import, et **contrôle croisé
automatique** de tous les identifiants DOM référencés par le JS contre `index.html` (aucun
identifiant manquant introduit). Les nouveaux échanges réseau (sonde de sources, suppression de
fichier) réutilisent le canal de contrôle **chiffré E2EE** et, pour la suppression, la **vérification
de signature** mise en place lors de l'audit.

> Note : l'extension n'a pas pu être chargée dans un vrai Chrome dans cet environnement ; un test
> manuel à deux navigateurs reste recommandé avant publication.
