#!/usr/bin/env python3
import struct
import zlib
import os
import math

def make_png(width, height, draw_fn):
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0) # Filter type 0 (None)
        for x in range(width):
            r, g, b, a = draw_fn(x, y, width, height)
            raw_data.extend([r, g, b, a])
            
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = zlib.crc32(c) & 0xffffffff
        return struct.pack('>I', len(data)) + c + struct.pack('>I', crc)
        
    png = bytearray(b'\x89PNG\r\n\x1a\n')
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    png.extend(chunk(b'IHDR', ihdr))
    png.extend(chunk(b'IDAT', zlib.compress(bytes(raw_data), 9)))
    png.extend(chunk(b'IEND', b''))
    return bytes(png)

def draw_icon(x, y, w, h):
    # Normalized coords from -1 to 1
    nx = (x / (w - 1)) * 2 - 1
    ny = (y / (h - 1)) * 2 - 1
    dist = math.sqrt(nx*nx + ny*ny)
    
    # Rounded squircle background
    r_corner = 0.82
    box_dist = max(abs(nx), abs(ny))
    if box_dist > 0.95:
        return (0, 0, 0, 0)
    
    # Premium deep violet to cyan-indigo gradient background
    t = (nx + ny + 2) / 4.0
    bg_r = int(18 + (10 - 18) * t)
    bg_g = int(24 + (160 - 24) * t)
    bg_b = int(48 + (255 - 48) * t)
    
    # Outer glow / border
    if box_dist > 0.88:
        return (60, 210, 255, 220)
    
    # Draw P2P mesh emblem: 3 nodes connected in a triangle with a central pulsing core
    nodes = [
        (0.0, -0.45),   # Top
        (-0.45, 0.35),  # Bottom Left
        (0.45, 0.35),   # Bottom Right
        (0.0, 0.0)      # Center
    ]
    
    # Check lines between nodes
    def dist_to_segment(px, py, x1, y1, x2, y2):
        l2 = (x2-x1)**2 + (y2-y1)**2
        if l2 == 0: return math.sqrt((px-x1)**2 + (py-y1)**2)
        tt = max(0, min(1, ((px-x1)*(x2-x1) + (py-y1)*(y2-y1)) / l2))
        proj_x = x1 + tt * (x2 - x1)
        proj_y = y1 + tt * (y2 - y1)
        return math.sqrt((px-proj_x)**2 + (py-proj_y)**2)
        
    line_thickness = 0.08
    is_line = False
    
    # Connections to center
    for i in range(3):
        if dist_to_segment(nx, ny, nodes[i][0], nodes[i][1], nodes[3][0], nodes[3][1]) < line_thickness:
            is_line = True
        if dist_to_segment(nx, ny, nodes[i][0], nodes[i][1], nodes[(i+1)%3][0], nodes[(i+1)%3][1]) < line_thickness:
            is_line = True
            
    # Nodes
    min_node_dist = 999.0
    is_center = False
    for i, (ndx, ndy) in enumerate(nodes):
        d = math.sqrt((nx-ndx)**2 + (ny-ndy)**2)
        if d < min_node_dist:
            min_node_dist = d
            is_center = (i == 3)
            
    if min_node_dist < 0.20:
        if is_center:
            # Cyan glowing core
            return (0, 255, 230, 255)
        else:
            # Violet-pink outer nodes
            return (255, 100, 220, 255)
    elif is_line:
        # Glowing link
        return (0, 220, 255, 230)
        
    return (bg_r, bg_g, bg_b, 255)

os.makedirs('icons', exist_ok=True)
for size in [16, 32, 48, 128]:
    png_data = make_png(size, size, draw_icon)
    path = f'icons/icon-{size}.png'
    with open(path, 'wb') as f:
        f.write(png_data)
    print(f"Generated {path} ({len(png_data)} bytes)")
