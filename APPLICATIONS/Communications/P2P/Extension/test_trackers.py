#!/usr/bin/env python3
import urllib.request
import ssl

trackers = [
    'https://tracker.openwebtorrent.com',
    'https://tracker.webtorrent.dev',
    'https://tracker.fastcast.nz',
    'https://tracker.btorrent.xyz',
    'https://tracker.files.fm:7073/announce'
]

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

for t in trackers:
    try:
        req = urllib.request.Request(t, headers={'User-Agent': 'WebTorrent'})
        with urllib.request.urlopen(req, timeout=3, context=ctx) as res:
            print(f"[ONLINE] {t} -> Code: {res.status}")
    except Exception as e:
        print(f"[OFFLINE/ERROR] {t} -> {e}")
