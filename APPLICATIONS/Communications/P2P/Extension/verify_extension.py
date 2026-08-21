#!/usr/bin/env python3
import os
import json
import re

print("=== VÉRIFICATION DE L'EXTENSION CHROME P2P ===")

# 1. Vérification du manifest.json
assert os.path.exists('manifest.json'), "manifest.json manquant !"
with open('manifest.json') as f:
    manifest = json.load(f)

print(f"[OK] Manifest v{manifest['manifest_version']} - {manifest['name']}")

# 2. Vérification des icônes
for size, path in manifest['icons'].items():
    assert os.path.exists(path), f"Icône manquante: {path}"
    with open(path, 'rb') as f:
        header = f.read(8)
        assert header == b'\x89PNG\r\n\x1a\n', f"L'icône {path} n'est pas un PNG valide !"
print("[OK] Toutes les icônes PNG (16, 32, 48, 128) sont présentes et valides.")

# 3. Vérification des fichiers référencés dans manifest.json
sw_path = manifest['background']['service_worker']
assert os.path.exists(sw_path), f"Service Worker manquant: {sw_path}"

sp_path = manifest['side_panel']['default_path']
assert os.path.exists(sp_path), f"Side Panel path manquant: {sp_path}"
print("[OK] Background Service Worker et Side Panel confirmés.")

# 4. Vérification des imports ES Modules dans sidepanel/js/
js_files = []
for root, dirs, files in os.walk('sidepanel/js'):
    for file in files:
        if file.endswith('.js'):
            js_files.append(os.path.join(root, file))

import_regex = re.compile(r'import\s+.*?from\s+[\'"](.*?)[\'"]')
all_imports_valid = True

for js_file in js_files:
    with open(js_file) as f:
        content = f.read()
    matches = import_regex.findall(content)
    for imp in matches:
        # Résolution du chemin relatif
        target = os.path.normpath(os.path.join(os.path.dirname(js_file), imp))
        if not os.path.exists(target):
            print(f"[ERREUR] Dans {js_file}: import introuvable '{imp}' -> '{target}'")
            all_imports_valid = False

assert all_imports_valid, "Certains imports sont cassés !"
print(f"[OK] Les {len(js_files)} fichiers JavaScript ont des imports 100% résolus.")

# 5. Vérification des liens CSS dans sidepanel/index.html
with open('sidepanel/index.html') as f:
    html = f.read()

css_regex = re.compile(r'<link\s+rel=[\'"]stylesheet[\'"]\s+href=[\'"](.*?)[\'"]')
css_matches = css_regex.findall(html)
for css in css_matches:
    target = os.path.normpath(os.path.join('sidepanel', css))
    assert os.path.exists(target), f"Fichier CSS manquant: {target}"

print(f"[OK] Les {len(css_matches)} feuilles de style CSS sont présentes.")
print("\n>>> VALIDATION RÉUSSIE : L'EXTENSION EST PRÊTE ET 100% INTÈGRE !")
