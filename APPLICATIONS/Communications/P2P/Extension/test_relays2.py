#!/usr/bin/env python3
import socket
import ssl

relays = [
    ("relay.damus.io", 443),
    ("relay.primal.net", 443),
    ("relay.nostr.band", 443),
    ("tracker.openwebtorrent.com", 443)
]

for host, port in relays:
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=3) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                print(f"[OK] {host}:{port}")
    except Exception as e:
        print(f"[ERR] {host}:{port} -> {e}")
