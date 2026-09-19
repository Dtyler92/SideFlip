"""Byte-authored PDF fixtures; preserves duplicate keys before MuPDF."""
from pathlib import Path
import sys
import zlib

path, mode = sys.argv[1:3]
BASE = b'/Type /Annot /Subtype /Link /Rect [10 10 100 30] /Border [0 0 0]'
PRIVATE = b'RAW_PRIVATE_CANARY_712934'

def link(tail):
    return b'<< ' + BASE + b' ' + tail + b' >>'


def object_stream_pdf(member):
    content = b'BT /F1 12 Tf 50 100 Td (Public page URL https://public.example/manual-body) Tj ET'
    base = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 7 0 R /Annots [8 0 R] >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream',
        b'<< /Length 0 >>\nstream\n\nendstream',
    ]
    header = b'8 0 '
    compressed = zlib.compress(header + member)
    assert zlib.decompress(compressed) == header + member
    objstm = b'<< /Type /ObjStm /N 1 /First ' + str(len(header)).encode() + b' /Filter /FlateDecode /Length ' + str(len(compressed)).encode() + b' >>\nstream\n' + compressed + b'\nendstream'
    data = b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
    offsets = {0: 0}
    for number, obj in [*enumerate(base, 1), (9, objstm)]:
        offsets[number] = len(data)
        data += str(number).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    xref_offset = len(data)
    entries = bytearray()
    for number in range(11):
        if number == 0:
            fields = (0, 0, 65535)
        elif number == 8:
            fields = (2, 9, 0)
        elif number == 10:
            fields = (1, xref_offset, 0)
        else:
            fields = (1, offsets[number], 0)
        entries.extend(fields[0].to_bytes(1, 'big') + fields[1].to_bytes(4, 'big') + fields[2].to_bytes(2, 'big'))
    xref = b'<< /Type /XRef /W [1 4 2] /Size 11 /Root 1 0 R /Length ' + str(len(entries)).encode() + b' >>\nstream\n' + bytes(entries) + b'\nendstream'
    data += b'10 0 obj\n' + xref + b'\nendobj\nstartxref\n' + str(xref_offset).encode() + b'\n%%EOF\n'
    return data


if mode in ('objstm-duplicate', 'objstm-safe'):
    member = link(b'/A << /S /URI /URI (javascript:RAW_PRIVATE_CANARY_712934) /URI (annotation-canary.example) >>') if mode == 'objstm-duplicate' else link(b'/A << /S /URI /URI (annotation-canary.example) >>')
    data = object_stream_pdf(member)
    Path(path).write_bytes(data)
    raise SystemExit(0)

annots = b'[8 0 R]'
extras = []
content = b'BT /F1 12 Tf 50 100 Td (Public page URL https://public.example/manual-body) Tj ET'
if mode == 'duplicate-action':
    annot = link(b'/A << /S /JavaScript /JS (' + PRIVATE + b') >> /A << /S /URI /URI (annotation-canary.example) >>')
elif mode == 'duplicate-action-private-goto':
    annot = link(b'/A << /S /GoTo /D [3 0 R /Fit] /Private (' + PRIVATE + b') >> /A << /S /GoTo /D [3 0 R /Fit] >>')
elif mode == 'duplicate-uri-nul':
    annot = link(b'/A << /S /URI /URI (annotation-canary.example\\000PRIVATE) /URI (annotation-canary.example) >>')
elif mode == 'duplicate-uri-javascript':
    annot = link(b'/A << /S /URI /URI (javascript:RAW_PRIVATE_CANARY_712934) /URI (annotation-canary.example) >>')
elif mode == 'duplicate-dest-private':
    annot = link(b'/Dest (' + PRIVATE + b') /Dest [3 0 R /Fit]')
elif mode == 'duplicate-rect-private':
    annot = link(b'/Dest [3 0 R /Fit]').replace(b'/Rect [10 10 100 30]', b'/Rect (' + PRIVATE + b') /Rect [10 10 100 30]')
elif mode == 'duplicate-subtype':
    annot = link(b'/Dest [3 0 R /Fit]').replace(b'/Subtype /Link', b'/Subtype /Text /Subtype /Link')
elif mode == 'duplicate-encoded-uri':
    annot = link(b'/A << /S /URI /UR#49 (javascript:RAW_PRIVATE_CANARY_712934) /URI (annotation-canary.example) >>')
elif mode == 'duplicate-comment-whitespace':
    annot = link(b'/A << /S /URI /URI (javascript:RAW_PRIVATE_CANARY_712934) % hidden duplicate\r\n /URI (annotation-canary.example) >>')
elif mode in ('ref-depth', 'ref-depth-32'):
    annot = link(b'/A 9 0 R')
    stop = 42 if mode == 'ref-depth' else 41
    extras = [f'{i + 1} 0 R'.encode() for i in range(9, stop)] + [b'<< /S /URI /URI (annotation-canary.example) >>']
elif mode == 'safe-string-lookalike':
    annot = link(b'/A << /S /URI /URI (annotation-canary.example) >>')
    content += b'\n% /A unsafe /A safe\nBT /F1 10 Tf 50 80 Td (/URI first /URI second) Tj ET'
elif mode == 'safe-stream-lookalike':
    annot = link(b'/Dest [3 0 R /Fit]')
    content += b'\n% << /URI (one) /URI (two) >>\n'
else:
    raise SystemExit('unknown raw fixture mode')

objects = [
    b'<< /Type /Catalog /Pages 2 0 R >>',
    b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 7 0 R /Annots ' + annots + b' >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream',
    b'<< /Length 0 >>\nstream\n\nendstream',
    annot,
    *extras,
]
data = b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
offsets = [0]
for number, obj in enumerate(objects, 1):
    offsets.append(len(data))
    data += str(number).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
xref = len(data)
data += b'xref\n0 ' + str(len(offsets)).encode() + b'\n0000000000 65535 f \n'
data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
data += b'trailer\n<< /Root 1 0 R /Size ' + str(len(offsets)).encode() + b' >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n'
Path(path).write_bytes(data)
# Assert source bytes, not a production parser or MuPDF canonical form.
assert annot in Path(path).read_bytes()
