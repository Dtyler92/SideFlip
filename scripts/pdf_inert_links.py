"""Fail-closed, bounded validation of inert PDF navigation (never executes URLs).

Canonical MuPDF object dictionaries, not get_links(), are the policy input.
Only the observed Ford link schema plus /Type /Annot is supported. Unsupported
PDFs are rejected rather than rewritten. No value from this module is exported.
"""
import math
import re
from urllib.parse import urlsplit, unquote
from ipaddress import IPv6Address


class Name(str):
    pass


class Ref(tuple):
    pass


class String(bytes):
    pass


def require(ok):
    if not ok:
        raise ValueError('Private annotations, forms or attachments are not permitted (unsupported PDF navigation)')


class Parser:
    def __init__(self, text):
        require(len(text) <= 2 * 1024 * 1024)
        self.s, self.i, self.nodes = text, 0, 0

    def ws(self):
        while self.i < len(self.s) and self.s[self.i].isspace():
            self.i += 1

    def value(self, depth=0):
        self.nodes += 1
        require(depth < 64 and self.nodes <= 100000)
        self.ws()
        s, i = self.s, self.i
        require(i < len(s))
        if s.startswith('<<', i):
            self.i += 2
            out = {}
            while True:
                self.ws()
                if s.startswith('>>', self.i):
                    self.i += 2
                    return out
                key = self.value(depth + 1)
                require(isinstance(key, Name) and key not in out)
                out[key] = self.value(depth + 1)
        if s[i] == '[':
            self.i += 1
            out = []
            while True:
                self.ws()
                require(self.i < len(s))
                if s[self.i] == ']':
                    self.i += 1
                    return out
                out.append(self.value(depth + 1))
        if s[i] == '(':
            self.i += 1
            out, nesting = bytearray(), 1
            while nesting:
                require(self.i < len(s))
                c = s[self.i]
                self.i += 1
                if c == '\\':
                    require(self.i < len(s))
                    c = s[self.i]
                    self.i += 1
                    if c in '01234567':
                        digits = c
                        for _ in range(2):
                            if self.i < len(s) and s[self.i] in '01234567':
                                digits += s[self.i]
                                self.i += 1
                        out.append(int(digits, 8) & 255)
                        continue
                    c = {'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f'}.get(c, c)
                    require(c not in '\r\n')  # conservative: no multiline escapes
                elif c == '(':
                    nesting += 1
                elif c == ')':
                    nesting -= 1
                    if not nesting:
                        break
                out.extend(c.encode('latin1'))
            return String(out)
        if s[i] == '<':
            end = s.index('>', i)
            h = re.sub(r'\s', '', s[i+1:end])
            require(re.fullmatch('[0-9a-fA-F]*', h) is not None)
            self.i = end + 1
            return String(bytes.fromhex(h + ('0' if len(h) % 2 else '')))
        if s[i] == '/':
            m = re.match(r'/([^\s<>\[\]()/]*)', s[i:])
            self.i += len(m[0])
            return Name(re.sub(r'#([0-9a-fA-F]{2})', lambda m: chr(int(m[1],16)), m[1]))
        m = re.match(r'[^\s<>\[\]()/]+', s[i:])
        require(m is not None)
        token = m[0]
        self.i += len(token)
        if token in ('true', 'false', 'null'):
            return {'true':True, 'false':False, 'null':None}[token]
        require(re.fullmatch(r'[+-]?(?:\d+\.?\d*|\.\d+)', token) is not None)
        number = float(token) if '.' in token else int(token)
        if type(number) is int:
            m = re.match(r'\s+(\d+)\s+R\b', s[self.i:])
            if m:
                self.i += len(m[0])
                return Ref((number, int(m[1])))
        require(math.isfinite(number))
        return number

    def parse(self):
        out = self.value()
        self.ws()
        require(self.i == len(self.s))
        return out


def validate_inert_links(doc):
    try:
        _validate(doc)
    except Exception:
        # Do not leak an annotation string through exception diagnostics.
        require(False)


def _validate(doc):
    require(not doc.is_repaired and doc.xref_length() <= 100000 and not doc.embfile_count())
    objects, total = {}, 0
    for x in range(1, doc.xref_length()):
        text = doc.xref_object(x, compressed=False)
        total += len(text)
        require(total <= 32 * 1024 * 1024)
        objects[x] = Parser(text).parse()
    pages = {p.xref for p in doc}

    def resolve(v):
        seen = set()
        while isinstance(v, Ref):
            require(v[1] == 0 and v[0] in objects and v[0] not in seen and len(seen) < 32)
            seen.add(v[0])
            require(not doc.xref_is_stream(v[0]))
            v = objects[v[0]]
            require(v is not None)
        return v

    def numeric(v):
        return type(v) in (int, float) and math.isfinite(v) and abs(v) <= 10000000

    catalog = objects[doc.pdf_catalog()]
    require('AcroForm' not in catalog)
    named, visited = {}, set()

    def name_tree(v, depth=0):
        require(depth < 32)
        if isinstance(v, Ref):
            require(v not in visited)
            visited.add(v)
        v = resolve(v)
        require(isinstance(v, dict) and set(v) <= {'Names','Kids','Limits'})
        require(not ('Names' in v and 'Kids' in v))
        if 'Limits' in v:
            limits = resolve(v['Limits'])
            require(isinstance(limits,list) and len(limits)==2 and all(isinstance(a,String) for a in limits))
        pairs = resolve(v.get('Names', []))
        require(isinstance(pairs,list) and len(pairs)%2==0)
        for i in range(0,len(pairs),2):
            require(isinstance(pairs[i],String) and pairs[i] not in named)
            named[pairs[i]] = pairs[i+1]
        kids = resolve(v.get('Kids', []))
        require(isinstance(kids,list))
        for kid in kids:
            name_tree(kid, depth+1)

    names = resolve(catalog.get('Names', {}))
    require(isinstance(names,dict) and set(names) <= {'Dests'})
    if 'Dests' in names:
        name_tree(names['Dests'])
    # Old-style named destination dictionaries are deliberately unsupported.
    require('Dests' not in catalog)

    def destination(v):
        v = resolve(v)
        if isinstance(v,String):
            require(v in named)
            v = resolve(named[v])
        if isinstance(v,dict):
            require(set(v)=={'D'})
            v = resolve(v['D'])
        require(isinstance(v,list) and len(v)>=2)
        require(isinstance(v[0],Ref) and v[0][1]==0 and v[0][0] in pages)
        require(isinstance(v[1],Name))
        sizes = {'XYZ':5, 'Fit':2, 'FitH':3, 'FitV':3, 'FitR':6, 'FitB':2, 'FitBH':3, 'FitBV':3}
        require(v[1] in sizes and len(v)==sizes[v[1]])
        require(all(numeric(a) or (a is None and v[1]!='FitR') for a in v[2:]))
        if v[1]=='XYZ':
            require(v[4] is None or v[4]>=0)
        if v[1]=='FitR':
            require(v[2]<=v[4] and v[3]<=v[5])

    def uri(v):
        v = resolve(v)
        require(isinstance(v,String) and 0 < len(v) <= 4096)
        s = v.decode('ascii')
        require(not re.search(r'[\x00-\x20\x7f\\]',s))
        require(not re.search(r'%(?![0-9a-fA-F]{2})',s))
        require(not re.search(r'[\x00-\x20\x7f\\]',unquote(s)))
        if not s.startswith(('http://','https://')):
            # Separately approved inert bare DNS syntax, NOT a URL inference.
            # No path/query/fragment/port, escapes, IP literal, single-label or
            # IDNA/punycode. Validate the exact decoded token without lookup or
            # adding a scheme; original PDF bytes and model bundle are untouched.
            labels = s.split('.')
            require(len(s) <= 253 and len(labels) >= 2)
            require(all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
                        and not label.lower().startswith('xn--') for label in labels))
            require(re.fullmatch(r'[A-Za-z]{2,63}', labels[-1]) is not None)
            return
        u = urlsplit(s)
        require(u.scheme in ('http','https') and u.netloc and u.hostname and u.username is None and u.password is None)
        require('%' not in u.netloc and u.port != 0)
        require(re.fullmatch(r"[A-Za-z0-9:/?#\[\]@!$&'()*+,;=._~%\-]+", s) is not None)
        require(re.fullmatch(r'(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9a-fA-F:]+\])(?::[0-9]{1,5})?', u.netloc) is not None)
        if ':' in u.hostname:
            IPv6Address(u.hostname)
        else:
            require(len(u.hostname) <= 253 and all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in u.hostname.split('.')))
        # No DNS or HTTP: URLs are inert and never included in the bundle.

    def action(v):
        v = resolve(v)
        require(isinstance(v,dict) and isinstance(v.get('S'),Name))
        if v['S']=='URI':
            require(set(v)=={'S','URI'})
            uri(v['URI'])
        else:
            require(v['S']=='GoTo' and set(v)=={'S','D'})
            destination(v['D'])

    def link(v):
        v = resolve(v)
        require(isinstance(v,dict) and set(v) <= {'Type','Subtype','Rect','Border','Dest','A'})
        require(v.get('Subtype')==Name('Link') and isinstance(v.get('Subtype'),Name))
        require('Type' not in v or (isinstance(v['Type'],Name) and v['Type']=='Annot'))
        rect = resolve(v.get('Rect'))
        require(isinstance(rect,list) and len(rect)==4 and all(numeric(a) for a in rect) and rect[0]<=rect[2] and rect[1]<=rect[3])
        if 'Border' in v:
            border = resolve(v['Border'])
            require(isinstance(border,list) and len(border)==3 and all(numeric(a) and a==0 for a in border))
        require(('Dest' in v) != ('A' in v))
        if 'Dest' in v:
            destination(v['Dest'])
        else:
            action(v['A'])

    for value in named.values():
        destination(value)
    if 'OpenAction' in catalog:
        destination(catalog['OpenAction'])
    for p in doc:
        annots = resolve(objects[p.xref].get('Annots', []))
        require(isinstance(annots,list) and len(annots)<=10000)
        for a in annots:
            link(a)
        require(p.first_annot is None and p.first_widget is None)

    forbidden = {'AcroForm','XFA','Fields','EmbeddedFiles','EF','AF','JS','JavaScript','AA','Launch','GoToR','GoToE','SubmitForm','ImportData','RichMedia','RichMediaContent','RichMediaSettings'}
    annotation_types = {'Text','Widget','FileAttachment','Popup','FreeText','Line','Square','Circle','Polygon','PolyLine','Highlight','Underline','Squiggly','StrikeOut','Stamp','Caret','Ink','Sound','Movie','Screen','Redact','3D','Watermark','PrinterMark','TrapNet'}
    def scan(v, depth=0):
        require(depth<64)
        if isinstance(v,Ref):
            require(v[1]==0 and v[0] in objects and objects[v[0]] is not None)
        elif isinstance(v,dict):
            require(not (set(v) & forbidden))
            require(v.get('Type') not in ('Filespec','EmbeddedFile'))
            if v.get('Type')=='Annot' or v.get('Subtype')=='Link' or ('Rect' in v and 'Subtype' in v):
                link(v)
            require(v.get('Subtype') not in annotation_types)
            if v.get('S') in ('URI','GoTo'):
                action(v)
            for a in v.values():
                scan(a,depth+1)
        elif isinstance(v,list):
            for a in v:
                scan(a,depth+1)
        elif isinstance(v,Name):
            require(v not in forbidden)
    for v in objects.values():
        scan(v)
