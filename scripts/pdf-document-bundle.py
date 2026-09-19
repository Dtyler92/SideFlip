"""Bounded text + geometry extraction; no manufacturer-specific rules."""
import sys, json, hashlib, re
import fitz
path, selection = sys.argv[1:3]
raw = open(path, 'rb').read(25 * 1024 * 1024 + 1)
if len(raw) > 25 * 1024 * 1024 or not raw.startswith(b'%PDF-'):
    raise ValueError('PDF bytes required; maximum 25 MiB')
# Inspect the original syntax before MuPDF can canonicalize duplicate keys or
# shorten indirect aliases. The canonical semantic gate below remains required.
if '--reject-private-annotations' in sys.argv[3:]:
    from pdf_raw_preflight import validate_raw_pdf
    validate_raw_pdf(raw)
doc = fitz.open(stream=raw, filetype='pdf')
if doc.is_encrypted or len(doc) > 2000:
    raise ValueError('Encrypted or oversized document')
# Job-bound public documents must not send owner notes, forms or attachments.
# Reject rather than silently stripping content and changing source identity.
if '--reject-private-annotations' in sys.argv[3:]:
    from pdf_inert_links import validate_inert_links
    validate_inert_links(doc)
numbers = set()
if not re.fullmatch(r'[1-9][0-9]*(?:-[1-9][0-9]*)?(?:,[1-9][0-9]*(?:-[1-9][0-9]*)?)*', selection):
    raise ValueError('Invalid page selection syntax')
for part in selection.split(','):
    ends = part.split('-')
    start, end = int(ends[0]), int(ends[-1])
    if start < 1 or end < start or end > len(doc) or end - start > 79:
        raise ValueError('Invalid page range')
    numbers.update(range(start, end + 1))
if not numbers or len(numbers) > 80:
    raise ValueError('Select 1–80 context-inclusive pages')
pages, signals = [], []
for n in sorted(numbers):
    p = doc[n-1]
    blocks = []
    for b in p.get_text('dict')['blocks']:
        if b['type'] != 0:
            continue
        text = '\n'.join(''.join(s['text'] for s in line['spans']) for line in b['lines'])
        spans = [s for line in b['lines'] for s in line['spans']]
        block = {'id': f'p{n}b{len(blocks)}', 'bbox': list(b['bbox']), 'text': text,
                 'maxFontSize': max((s['size'] for s in spans), default=0)}
        blocks.append(block)
        if re.search(r'\b(note|exception|caution|warning|until|whichever|initial|subsequent|only|primary|not exceed|every other)\b|^\s*\d[ .)]', text, re.I):
            signals.append({'id': block['id'], 'pdfPage': n, 'quote': text})
    page = {'pdfPage': n, 'width': p.rect.width, 'height': p.rect.height,
            'text': p.get_text(), 'blocks': blocks}
    # Conservative location extraction, not publisher/semantic verification.
    # Never infer a document-wide offset, or choose between ambiguous numerals.
    footer_numbers = [b for b in blocks
                      if re.fullmatch(r'[1-9][0-9]{0,5}', b['text'].strip())
                      and b['bbox'][1] >= p.rect.height * .88]
    if len(footer_numbers) == 1:
        b = footer_numbers[0]
        if abs((b['bbox'][0] + b['bbox'][2]) / 2 - p.rect.width / 2) <= p.rect.width * .08:
            page['printedPage'] = int(b['text'].strip())
            page['printedPageEvidence'] = {
                'blockId': b['id'], 'quote': b['text'], 'bbox': b['bbox'],
                'method': 'isolated_centered_numeric_footer',
                'status': 'extracted_unreviewed',
            }
    pages.append(page)
result = {'bundleVersion': 1, 'sourceSha256': hashlib.sha256(raw).hexdigest(),
          'byteLength': len(raw), 'pageCount': len(doc), 'selectedPages': sorted(numbers),
          'pages': pages, 'contextSignals': signals,
          'scope': 'selected pages only; completeness and layout require semantic review',
          'parser': 'PyMuPDF ' + fitz.VersionBind}
out = json.dumps(result)
if len(out.encode()) > 4 * 1024 * 1024:
    raise ValueError('Bundle exceeds 4 MiB')
print(out)
