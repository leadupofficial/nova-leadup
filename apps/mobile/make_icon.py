import struct, zlib, os

def chunk(ctype, data):
 c = ctype + data
 return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

def make_png(path):
 ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
 raw = b'\xff\x00\x00\xff\x00\x00\xff\x00\x00'
 raw += b'\x00\xff\x00\x00\xff'
 idat = zlib.compress(raw)
 png = b'\x89PNG\r\n\x1a\n'
 png += chunk(b'IHDR', ihdr)
 png += chunk(b'IDAT', idat)
 png += chunk(b'IEND', b'')
 with open(path, 'wb') as f:
 f.write(png)
 print(f'Created {path} ({len(png)} bytes)')

os.makedirs('assets', exist_ok=True)
make_png('assets/icon.png')
