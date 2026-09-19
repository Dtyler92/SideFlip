"""Generated synthetic originals; never modifies the retained Ford document."""
import fitz
import sys
import json
from pathlib import Path

bare_cases = json.loads((Path(__file__).parent.parent / 'fixtures/inert-bare-host-cases.json').read_text())

path, mode = sys.argv[1:3]
d = fitz.open()
p = d.new_page()
p.insert_text((72,72), 'Public page URL https://public.example/manual-body')
p = d.new_page()
page = d[0].xref
base = '/Type /Annot /Subtype /Link /Rect [10 10 100 30] /Border [0 0 0]'
url = 'https://annotation-canary.example/ONLY_IN_ANNOTATION_984771'
action = f'/A << /S /URI /URI ({url}) >>'
extra = ''
x = None
raw = None
if mode == 'http': action = '/A << /S /URI /URI (http://annotation-canary.example/ONLY_IN_ANNOTATION_984771) >>'
if mode == 'internal': action = f'/Dest [{page} 0 R /XYZ 0 0 0]'
if mode == 'goto': action = f'/A << /S /GoTo /D [{page} 0 R /Fit] >>'
if mode == 'named':
 action = '/Dest (chapter)'
 x=d.get_new_xref();d.update_object(x,f'<< /D [{page} 0 R /XYZ null null 0] >>')
 d.xref_set_key(d.pdf_catalog(),'Names',f'<< /Dests << /Names [(chapter) {x} 0 R] >> >>')
if mode == 'indirect':
 x=d.get_new_xref();d.update_object(x,f'<< /S /URI /URI ({url}) >>');action=f'/A {x} 0 R'
uris = {'schemeless':'www.example.com','javascript':'javascript:alert%281%29','credentials':'https://owner:secret@example.com/','control':'https://example.com/%0aSECRET','space':'https://example.com/a b','scheme-trick':'https:%2f%2fexample.com','backslash':'https://example.com\\\\evil','bad-port':'https://example.com:99999','malformed-percent':'https://example.com/%ZZ'}
if mode in uris: action = f'/A << /S /URI /URI ({uris[mode]}) >>'
if mode in bare_cases:
 # Hex preserves every tested byte (including controls/backslashes); do not
 # let PDF literal-string escapes accidentally sanitize an adversarial case.
 raw = bare_cases[mode]['value'].encode('utf-8')
 action = f'/A << /S /URI /URI <{raw.hex()}> >>'
if mode.startswith('bare-field-') or mode in ('bare-action-extra', 'bare-uri-name', 'bare-uri-number'):
 action = '/A << /S /URI /URI (annotation-canary.example) >>'
 if mode.startswith('bare-field-'):
  field = mode.removeprefix('bare-field-')
  assert field in ('BS','NM','AP','F','P','C','H','QuadPoints','Popup','M','CreationDate','RC','Subj')
  extra = f'/{field} (HIDDEN_PRIVATE_CANARY_984771)'
 if mode == 'bare-action-extra': action = '/A << /S /URI /URI (annotation-canary.example) /Future (HIDDEN_PRIVATE_CANARY_984771) >>'
 if mode == 'bare-uri-name': action = '/A << /S /URI /URI /annotation-canary.example >>'
 if mode == 'bare-uri-number': action = '/A << /S /URI /URI 123 >>'
if mode in ('contents','author','unknown','hidden-metadata','aa'):
 extra = {'contents':'/Contents (HIDDEN_PRIVATE_CANARY_984771)','author':'/T (HIDDEN_PRIVATE_CANARY_984771)','unknown':'/FutureKey (HIDDEN_PRIVATE_CANARY_984771)','hidden-metadata':'/Metadata << /Secret (HIDDEN_PRIVATE_CANARY_984771) >>','aa':'/AA << /E << /S /JavaScript /JS (HIDDEN_PRIVATE_CANARY_984771) >> >>'}[mode]
if mode == 'chain': action=f'/A << /S /URI /URI ({url}) /Next << /S /URI /URI (https://other.example/) >> >>'
if mode in ('launch','remote','embedded','unknown-action'):
 s={'launch':'Launch','remote':'GoToR','embedded':'GoToE','unknown-action':'FutureAction'}[mode];action=f'/A << /S /{s} /D (HIDDEN_PRIVATE_CANARY_984771) >>'
if mode == 'bad-dest': action='/Dest [99999 0 R /Fit]'
if mode == 'generation': action=f'/Dest [{page} 1 R /Fit]'
if mode == 'cycle':
 x=d.get_new_xref();d.update_object(x,f'{x} 0 R');action=f'/Dest {x} 0 R'
if mode == 'both': action += f' /Dest [{page} 0 R /Fit]'
if mode == 'nonlink': base='/Type /Annot /Subtype /FutureAnnotation /Rect [10 10 100 30]'
if mode == 'geometry': base='/Subtype /Link /Rect [100 10 10 30]'
if mode == 'text': p.add_text_annot((100,100),'HIDDEN_PRIVATE_CANARY_984771')
elif mode == 'widget':
 w=fitz.Widget();w.field_name='HIDDEN_PRIVATE_CANARY_984771';w.field_type=fitz.PDF_WIDGET_TYPE_TEXT;w.rect=fitz.Rect(10,10,100,30);p.add_widget(w)
elif mode == 'attachment': d.embfile_add('private.txt',b'HIDDEN_PRIVATE_CANARY_984771')
else:
 x=d.get_new_xref();d.update_object(x,f'<< {base} {action} {extra} >>')
 if mode != 'orphan-unsafe': d.xref_set_key(p.xref,'Annots',f'[{x} 0 R]')
 else: d.xref_set_key(x,'Contents','(HIDDEN_PRIVATE_CANARY_984771)')
 if mode == 'mixed': p.add_text_annot((100,100),'HIDDEN_PRIVATE_CANARY_984771')
 if mode == 'orphan-script':
  x=d.get_new_xref();d.update_object(x,'<< /S /JavaScript /JS (HIDDEN_PRIVATE_CANARY_984771) >>')
d.save(path)
if mode in bare_cases:
 # Independently decode the canonical string, preserving NUL (xref_get_key
 # truncates at NUL). Do not use the policy parser to verify its own fixture.
 import re
 with fitz.open(path) as saved:
  assert x is not None and raw is not None
  match = re.search(r'/URI\s+(<(?:[0-9A-Fa-f\s])*?>|\((?:\\.|[^\\)])*\))', saved.xref_object(x, compressed=False))
  assert match is not None
  token = match.group(1)
  if token.startswith('<'):
   actual = bytes.fromhex(token[1:-1])
  else:
   def escape(match: re.Match[str]) -> str:
    v = match.group(1)
    if v[0] in '01234567': return chr(int(v, 8))
    return {'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f'}.get(v, v)
   actual = re.sub(r'\\([0-7]{1,3}|.)', escape, token[1:-1]).encode('latin1')
  assert actual == raw, 'Fixture did not preserve exact URI bytes'
