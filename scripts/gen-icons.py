"""Generate Tauri 2 icon set from Chunky_Icon.png using Pillow."""
import os
import sys
import struct
import io
from PIL import Image

src = os.path.join(os.path.dirname(__file__), "..", "Chunky_Icon.png")
icons_dir = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
os.makedirs(icons_dir, exist_ok=True)

img = Image.open(src).convert("RGBA")

png_sizes = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}

for name, sz in png_sizes.items():
    out = img.resize((sz, sz), Image.LANCZOS)
    out.save(os.path.join(icons_dir, name), "PNG")
    print(f"  {name} ({sz}x{sz})")

# ── icon.ico (Windows multi-size: 16, 24, 32, 48, 64, 128, 256) ──────────────
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico_images = []
for sz in ico_sizes:
    frame = img.resize((sz, sz), Image.LANCZOS)
    buf = io.BytesIO()
    frame.save(buf, format="PNG")
    ico_images.append((sz, buf.getvalue()))

# ICO format: ICONDIR header + ICONDIRENTRY * n + PNG data blobs
ico_path = os.path.join(icons_dir, "icon.ico")
with open(ico_path, "wb") as f:
    n = len(ico_images)
    # ICONDIR: reserved(2) type(2) count(2)
    f.write(struct.pack("<HHH", 0, 1, n))
    # ICONDIRENTRY * n: w(1) h(1) colorCount(1) reserved(1) planes(2) bitCount(2) size(4) offset(4)
    offset = 6 + n * 16
    entries = []
    for sz, data in ico_images:
        w = sz if sz < 256 else 0
        h = sz if sz < 256 else 0
        entries.append(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    for e in entries:
        f.write(e)
    for _, data in ico_images:
        f.write(data)
print(f"  icon.ico ({len(ico_sizes)} sizes)")

# ── icon.icns (macOS) — write an ICNS with PNG payloads ──────────────────────
# ICNS format: magic(4) + total_len(4) + [type(4) len(4) data]...
icns_map = {
    "ic04": 16,   # 16x16
    "ic05": 32,   # 32x32 (actually 16@2x but same pixels)
    "ic07": 128,  # 128x128
    "ic08": 256,  # 256x256
    "ic09": 512,  # 512x512
    "ic10": 1024, # 512@2x / 1024
    "ic11": 32,   # 16@2x
    "ic12": 64,   # 32@2x
    "ic13": 256,  # 128@2x
    "ic14": 512,  # 256@2x
}
chunks = []
for tag, sz in icns_map.items():
    frame = img.resize((sz, sz), Image.LANCZOS)
    buf = io.BytesIO()
    frame.save(buf, format="PNG")
    data = buf.getvalue()
    # chunk header: type(4) + length(4 including header) = 8 bytes
    chunks.append(tag.encode("ascii") + struct.pack(">I", len(data) + 8) + data)

total = 8 + sum(len(c) for c in chunks)
icns_path = os.path.join(icons_dir, "icon.icns")
with open(icns_path, "wb") as f:
    f.write(b"icns")
    f.write(struct.pack(">I", total))
    for c in chunks:
        f.write(c)
print(f"  icon.icns ({len(icns_map)} sizes)")

print("Done.")
