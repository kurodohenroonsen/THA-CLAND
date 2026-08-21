#!/usr/bin/env python3
import socket
import ssl

hosts = [
    ("tracker.openwebtorrent.com", 443),
    ("relay.damus.io", 443),
    ("nos.today", 443),
    ("relay.primal.net", 443)
]

for host, port in hosts:
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=3) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                print(f"[SSL OK] {host}:{port}")
    except Exception as e:
        print(f"[ERROR] {host}:{port} -> {e}")
