# 🌐 P2P Mesh — Version Web hébergée (PWA iOS / Android)

Version **100% statique** de l'extension Chrome : mêmes fonctions (chat E2EE, forum
répliqué, Drive P2P avec versioning, salons vocaux/vidéo mesh), mais utilisable
depuis **n'importe quel navigateur mobile** et **installable** sur l'écran d'accueil
(Progressive Web App). Aucun backend : tout reste pair‑à‑pair via WebRTC + trackers
WebSocket / relais Nostr, exactement comme l'extension.

URL cible prévue : **`https://aeternitrak.com/a`**

---

## ⚠️ 1. HTTPS OBLIGATOIRE (le point le plus important)

L'application **ne fonctionne pas en `http://`**. Elle a besoin d'un *contexte
sécurisé* pour :

- `crypto.subtle` — **tout le chiffrement de bout en bout** (PBKDF2, ECDSA, AES‑GCM) ;
- `getUserMedia` — **micro / caméra** des salons vocaux‑vidéo ;
- le **Service Worker** (installation PWA, hors‑ligne) ;
- les **notifications**.

Sur `http://aeternitrak.com/a`, le navigateur mobile bloque ces API : l'app
affichera un écran « Connexion sécurisée requise ». Il faut donc un certificat TLS
(gratuit avec **Let's Encrypt / certbot**) et servir en **`https://aeternitrak.com/a`**.

> Exception : `http://localhost` est considéré comme sécurisé (utile pour tester en local).

---

## 📁 2. Contenu à déposer

Déposez **tout le contenu de ce dossier** dans le répertoire servi à l'URL `/a`.
Arborescence attendue côté serveur :

```
/a/
├── index.html
├── manifest.webmanifest
├── sw.js                ← doit être servi depuis /a/ (portée du Service Worker)
├── permissions.html
├── permissions.js
├── css/…
├── js/…                 (dont js/platform-web.js)
└── icons/…
```

Tous les chemins sont **relatifs** : l'app fonctionne telle quelle sous `/a/`
(ou tout autre sous‑dossier), à condition que **`/a` serve bien `index.html`**.

---

## ⚙️ 3. Configuration serveur

### Important : le dossier `/a` doit avoir un « slash final »
Le Service Worker et le manifest se résolvent relativement à `/a/`. Configurez une
redirection de `/a` vers `/a/` (sinon les chemins relatifs cassent).

### Apache (`.htaccess` dans `/a/`)
```apache
# Redirige /a vers /a/ (slash final)
DirectorySlash On
DirectoryIndex index.html

# Types MIME corrects
AddType text/javascript .js
AddType application/manifest+json .webmanifest

# Le Service Worker ne doit pas être mis en cache trop longtemps
<Files "sw.js">
  Header set Cache-Control "no-cache"
</Files>
```

### Nginx
```nginx
location = /a { return 301 /a/; }

location /a/ {
    alias /var/www/aeternitrak/a/;
    try_files $uri $uri/ /a/index.html;
    types { text/javascript js; application/manifest+json webmanifest; }
    location = /a/sw.js { add_header Cache-Control "no-cache"; }
}
```

---

## 📲 4. Installation sur mobile

- **Android / Chrome** : une bannière « Installer l'application » apparaît (ou menu ⋮ →
  « Ajouter à l'écran d'accueil »).
- **iOS / Safari** : bouton **Partager** → **Sur l'écran d'accueil**. (Les notifications
  push nécessitent iOS 16.4+ et l'app installée.)

Une fois installée, elle s'ouvre en plein écran comme une app native (mode *standalone*),
avec gestion des encoches (safe‑area).

---

## 🔗 5. Compatibilité & notes

- **Fonctionne** sur Safari iOS 15.4+, Chrome/Edge/Firefox Android récents, et tous les
  navigateurs desktop modernes.
- WebRTC, WebSocket sécurisé (`wss://`) vers les trackers et relais Nostr fonctionnent
  directement depuis le navigateur — **aucun serveur central** n'est ajouté.
- Le Service Worker met en cache **uniquement la coquille de l'app** (HTML/CSS/JS/icônes)
  pour le hors‑ligne et la rapidité. Il ne touche jamais au trafic P2P.
- Le fichier `js/platform-web.js` traduit les rares appels `chrome.*` (hérités de
  l'extension) vers les API web standard : **aucune logique métier n'a été modifiée**,
  la parité fonctionnelle avec l'extension est conservée.

---

## ✅ 6. Test rapide après déploiement

1. Ouvrez `https://aeternitrak.com/a` sur mobile → l'écran d'accueil P2P doit s'afficher
   (pas d'écran « Connexion sécurisée requise »).
2. « Générer un Nouveau Groupe » → un code papier apparaît, la jauge indique « Robustesse forte ».
3. Sur un 2ᵉ appareil, saisissez le **même code papier** → les deux pairs se découvrent
   et le chat/Drive se synchronise.
4. Testez « Autorisations Micro/Caméra » puis un salon vocal.
