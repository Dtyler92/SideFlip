"""Valid hybrid-reference PDFs for raw-preflight regressions."""
from pathlib import Path
import sys, zlib
path, mode = sys.argv[1:3]
content = b'BT /F1 12 Tf 50 100 Td (Public manual) Tj ET'
base = {
    1: b'<< /Type /Catalog /Pages 2 0 R >>',
    2: b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R] >>',
    4: b'null',
    5: b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    6: b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream',
    7: b'null',
}
if mode == 'hybrid-duplicate':
    member = b'<< /Type /Annot /Subtype /Link /Rect [10 10 100 30] /Border [0 0 0] /A << /S /URI /URI (javascript:RAW_HYBRID_CANARY) /URI (annotation-canary.example) >> >>'
    header = b'8 0 '
    compressed = zlib.compress(header + member)
    base[9] = b'<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ' + str(len(compressed)).encode() + b' >>\nstream\n' + compressed + b'\nendstream'
    size, xref_number = 11, 10
elif mode == 'hybrid-alias':
    base[8] = b'<< /Type /Annot /Subtype /Link /Rect [10 10 100 30] /Border [0 0 0] /A 11 0 R >>'
    for number in range(11, 44):
        base[number] = f'{number + 1} 0 R'.encode()
    base[44] = b'<< /S /URI /URI (annotation-canary.example) >>'
    size, xref_number = 46, 45
else:
    raise SystemExit('unknown mode')
data = b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
offsets = {}
for number in sorted(base):
    offsets[number] = len(data)
    data += f'{number} 0 obj\n'.encode() + base[number] + b'\nendobj\n'
xref_offset = len(data)
entries = bytearray()
for number in range(size):
    if number == 0:
        fields = (0, 0, 65535)
    elif number == xref_number:
        fields = (1, xref_offset, 0)
    elif mode == 'hybrid-duplicate' and number == 8:
        fields = (2, 9, 0)
    elif number in offsets:
        fields = (1, offsets[number], 0)
    else:
        fields = (0, 0, 0)
    entries += fields[0].to_bytes(1, 'big') + fields[1].to_bytes(4, 'big') + fields[2].to_bytes(2, 'big')
xref = b'<< /Type /XRef /W [1 4 2] /Size ' + str(size).encode() + b' /Root 1 0 R /Length ' + str(len(entries)).encode() + b' >>\nstream\n' + bytes(entries) + b'\nendstream'
data += f'{xref_number} 0 obj\n'.encode() + xref + b'\nendobj\n'
classic = len(data)
classic_numbers = list(range(0, 8 if mode == 'hybrid-duplicate' else 9))
data += b'xref\n0 ' + str(len(classic_numbers)).encode() + b'\n0000000000 65535 f \n'
for number in classic_numbers[1:]:
    if number in offsets:
        data += f'{offsets[number]:010d} 00000 n \n'.encode()
    else:
        data += b'0000000000 00000 f \n'
data += f'{xref_number} 1\n{xref_offset:010d} 00000 n \n'.encode()
data += b'trailer\n<< /Size ' + str(size).encode() + b' /Root 1 0 R /XRefStm ' + str(xref_offset).encode() + b' >>\nstartxref\n' + str(classic).encode() + b'\n%%EOF\n'
Path(path).write_bytes(data)
if mode == 'hybrid-duplicate':
    assert zlib.decompress(compressed) == header + member
