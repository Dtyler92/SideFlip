"""Bounded raw-PDF structural preflight before MuPDF canonicalization.

This is deliberately a narrow fail-closed parser. It detects duplicate PDF
name keys and whole-object alias chains in the original bytes. Unsupported or
ambiguous structures reject; no source-specific exception is permitted.
"""
import math
import re
import zlib

ERROR = 'Private annotations, forms or attachments are not permitted (unsupported PDF navigation)'
MAX_OBJECTS = 100000
MAX_DEPTH = 64
MAX_NODES = 100000
MAX_DECODED = 32 * 1024 * 1024
MAX_ALIAS_HOPS = 32
WS = b'\x00\x09\x0a\x0c\x0d\x20'
DELIMS = b'()<>[]{}/%'


class Name(bytes):
    pass


class Ref(tuple):
    pass


def fail(ok=False):
    if not ok:
        raise ValueError(ERROR)


class Parser:
    def __init__(self, data, pos=0, end=None):
        self.data = data
        self.pos = pos
        self.end = len(data) if end is None else end
        self.nodes = 0

    def skip(self):
        while self.pos < self.end:
            c = self.data[self.pos]
            if c in WS:
                self.pos += 1
            elif c == 37:  # comment
                self.pos += 1
                while self.pos < self.end and self.data[self.pos] not in (10, 13):
                    self.pos += 1
            else:
                break

    def token(self):
        self.skip()
        start = self.pos
        while self.pos < self.end and self.data[self.pos] not in WS + DELIMS:
            self.pos += 1
        fail(self.pos > start)
        return self.data[start:self.pos]

    def value(self, depth=0):
        self.nodes += 1
        fail(depth < MAX_DEPTH and self.nodes <= MAX_NODES)
        self.skip()
        fail(self.pos < self.end)
        data, c = self.data, self.data[self.pos]
        if data.startswith(b'<<', self.pos):
            self.pos += 2
            result, seen = {}, set()
            while True:
                self.skip()
                fail(self.pos < self.end)
                if data.startswith(b'>>', self.pos):
                    self.pos += 2
                    return result
                key = self.value(depth + 1)
                fail(isinstance(key, Name) and key not in seen)
                seen.add(key)
                result[key] = self.value(depth + 1)
        if c == 91:  # [
            self.pos += 1
            result = []
            while True:
                self.skip()
                fail(self.pos < self.end)
                if data[self.pos] == 93:
                    self.pos += 1
                    return result
                result.append(self.value(depth + 1))
        if c == 40:  # literal string
            self.pos += 1
            result, nesting = bytearray(), 1
            while nesting:
                fail(self.pos < self.end)
                c = data[self.pos]
                self.pos += 1
                if c == 92:
                    fail(self.pos < self.end)
                    c = data[self.pos]
                    self.pos += 1
                    if 48 <= c <= 55:
                        digits = bytes((c,))
                        for _ in range(2):
                            if self.pos < self.end and 48 <= data[self.pos] <= 55:
                                digits += data[self.pos:self.pos + 1]
                                self.pos += 1
                            else:
                                break
                        result.append(int(digits, 8) & 255)
                        continue
                    if c in (10, 13):
                        if c == 13 and self.pos < self.end and data[self.pos] == 10:
                            self.pos += 1
                        continue
                    c = {110: 10, 114: 13, 116: 9, 98: 8, 102: 12}.get(c, c)
                elif c == 40:
                    nesting += 1
                elif c == 41:
                    nesting -= 1
                    if not nesting:
                        break
                elif c == 13:
                    if self.pos < self.end and data[self.pos] == 10:
                        self.pos += 1
                    c = 10
                result.append(c)
            return bytes(result)
        if c == 60:  # hex string
            self.pos += 1
            start = self.pos
            while self.pos < self.end and data[self.pos] != 62:
                self.pos += 1
            fail(self.pos < self.end)
            raw = re.sub(rb'[\x00\x09\x0a\x0c\x0d\x20]', b'', data[start:self.pos])
            fail(re.fullmatch(rb'[0-9A-Fa-f]*', raw) is not None)
            self.pos += 1
            return bytes.fromhex((raw + (b'0' if len(raw) % 2 else b'')).decode())
        if c == 47:  # name
            self.pos += 1
            result = bytearray()
            while self.pos < self.end and data[self.pos] not in WS + DELIMS:
                c = data[self.pos]
                self.pos += 1
                if c == 35:
                    fail(self.pos + 2 <= self.end and re.fullmatch(rb'[0-9A-Fa-f]{2}', data[self.pos:self.pos + 2]))
                    c = int(data[self.pos:self.pos + 2], 16)
                    self.pos += 2
                    # Escaped delimiter/whitespace bytes are legal in PDF names;
                    # compare their decoded bytes so equivalent spellings collide.
                    fail(c != 0)
                result.append(c)
            return Name(result)
        token = self.token()
        if token in (b'true', b'false', b'null'):
            return {b'true': True, b'false': False, b'null': None}[token]
        fail(re.fullmatch(rb'[+-]?(?:\d+\.?\d*|\.\d+)', token) is not None)
        number = float(token) if b'.' in token else int(token)
        fail(type(number) is int or math.isfinite(number))
        if type(number) is int:
            saved = self.pos
            self.skip()
            generation_start = self.pos
            try:
                generation = self.token()
                if re.fullmatch(rb'\d+', generation):
                    self.skip()
                    if self.data.startswith(b'R', self.pos) and (self.pos + 1 == self.end or self.data[self.pos + 1] in WS + DELIMS):
                        self.pos += 1
                        return Ref((number, int(generation)))
            except ValueError:
                pass
            self.pos = saved
        return number


class RawPdf:
    def __init__(self, raw):
        self.raw = raw
        self.decoded = 0
        self.revisions = []
        self.live = {}
        self.values = {}
        self.streams = {}

    def decode_stream(self, dictionary, payload, *, xref=False):
        filters = dictionary.get(Name(b'Filter'))
        if filters is None:
            decoded = payload
        else:
            if isinstance(filters, list):
                fail(filters == [Name(b'FlateDecode')])
            else:
                fail(filters == Name(b'FlateDecode'))
            remaining = MAX_DECODED - self.decoded
            fail(remaining >= 0)
            try:
                inflater = zlib.decompressobj()
                decoded = inflater.decompress(payload, remaining + 1)
                if len(decoded) <= remaining:
                    decoded += inflater.flush(remaining + 1 - len(decoded))
            except Exception:
                fail()
            fail(len(decoded) <= remaining and inflater.eof and not inflater.unused_data and not inflater.unconsumed_tail)
            params = dictionary.get(Name(b'DecodeParms'))
            if params is not None:
                fail(xref and isinstance(params, dict))
                fail(set(params) <= {Name(b'Predictor'), Name(b'Columns'), Name(b'Colors'), Name(b'BitsPerComponent')})
                predictor = params.get(Name(b'Predictor'), 1)
                columns = params.get(Name(b'Columns'))
                fail(params.get(Name(b'Colors'), 1) == 1 and params.get(Name(b'BitsPerComponent'), 8) == 8)
                fail(type(predictor) is int and 10 <= predictor <= 15 and type(columns) is int and 0 < columns <= 64)
                decoded = self.png_predictor(decoded, columns)
        self.decoded += len(decoded)
        fail(self.decoded <= MAX_DECODED)
        return decoded

    @staticmethod
    def png_predictor(data, columns):
        row_size = columns + 1
        fail(len(data) % row_size == 0)
        out, prior = bytearray(), bytes(columns)
        for offset in range(0, len(data), row_size):
            kind, encoded = data[offset], data[offset + 1:offset + row_size]
            fail(kind <= 4)
            row = bytearray(columns)
            for index, value in enumerate(encoded):
                left = row[index - 1] if index else 0
                up = prior[index]
                upper_left = prior[index - 1] if index else 0
                if kind == 0:
                    add = 0
                elif kind == 1:
                    add = left
                elif kind == 2:
                    add = up
                elif kind == 3:
                    add = (left + up) // 2
                else:
                    p = left + up - upper_left
                    distances = (abs(p - left), abs(p - up), abs(p - upper_left))
                    add = (left, up, upper_left)[distances.index(min(distances))]
                row[index] = (value + add) & 255
            out.extend(row)
            prior = bytes(row)
        return bytes(out)

    def indirect(self, offset, expected=None):
        fail(type(offset) is int and 0 <= offset < len(self.raw))
        parser = Parser(self.raw, offset)
        number = parser.value()
        generation = parser.value()
        fail(type(number) is int and type(generation) is int and number > 0 and 0 <= generation <= 65535)
        parser.skip()
        fail(self.keyword(parser.pos, b'obj'))
        parser.pos += 3
        if expected is not None:
            fail((number, generation) == expected)
        value = parser.value()
        parser.skip()
        payload = None
        if self.keyword(parser.pos, b'stream'):
            fail(isinstance(value, dict))
            parser.pos += 6
            if self.raw.startswith(b'\r\n', parser.pos):
                parser.pos += 2
            elif self.raw.startswith((b'\r', b'\n'), parser.pos):
                parser.pos += 1
            else:
                fail()
            length = value.get(Name(b'Length'))
            fail(type(length) is int and 0 <= length <= 25 * 1024 * 1024)
            end = parser.pos + length
            fail(end <= len(self.raw))
            payload = self.raw[parser.pos:end]
            parser.pos = end
            if self.raw.startswith(b'\r\n', parser.pos):
                parser.pos += 2
            elif self.raw.startswith((b'\r', b'\n'), parser.pos):
                parser.pos += 1
            fail(self.keyword(parser.pos, b'endstream'))
            parser.pos += 9
            parser.skip()
        fail(self.keyword(parser.pos, b'endobj'))
        return number, generation, value, payload

    def keyword(self, position, word):
        end = position + len(word)
        return (self.raw.startswith(word, position) and
                (end == len(self.raw) or self.raw[end] in WS + DELIMS))

    def xref_stream(self, offset):
        number, generation, dictionary, payload = self.indirect(offset)
        fail(generation == 0 and isinstance(dictionary, dict) and dictionary.get(Name(b'Type')) == Name(b'XRef') and payload is not None)
        widths = dictionary.get(Name(b'W'))
        fail(isinstance(widths, list) and len(widths) == 3 and all(type(x) is int and 0 <= x <= 8 for x in widths) and sum(widths) > 0)
        size = dictionary.get(Name(b'Size'))
        fail(type(size) is int and 0 < size <= MAX_OBJECTS)
        index = dictionary.get(Name(b'Index'), [0, size])
        fail(isinstance(index, list) and len(index) % 2 == 0 and all(type(x) is int and x >= 0 for x in index))
        decoded = self.decode_stream(dictionary, payload, xref=True)
        width = sum(widths)
        total = sum(index[i + 1] for i in range(0, len(index), 2))
        fail(total <= MAX_OBJECTS and len(decoded) == total * width)
        entries, cursor = {}, 0
        for i in range(0, len(index), 2):
            first, count = index[i], index[i + 1]
            fail(first + count <= MAX_OBJECTS)
            for obj in range(first, first + count):
                fields = []
                for field, amount in enumerate(widths):
                    fields.append(int.from_bytes(decoded[cursor:cursor + amount], 'big') if amount else (1 if field == 0 else 0))
                    cursor += amount
                fail(fields[0] in (0, 1, 2) and obj not in entries and obj < size)
                fail((fields[0] != 1 or fields[2] <= 65535) and (fields[0] != 2 or fields[2] < MAX_OBJECTS))
                entries[obj] = tuple(fields)
        return dictionary, entries, (number, offset)

    def classic_xref(self, offset):
        parser = Parser(self.raw, offset)
        parser.skip()
        fail(self.raw.startswith(b'xref', parser.pos))
        parser.pos += 4
        entries = {}
        while True:
            parser.skip()
            if self.raw.startswith(b'trailer', parser.pos):
                parser.pos += 7
                trailer = parser.value()
                fail(isinstance(trailer, dict))
                size = trailer.get(Name(b'Size'))
                fail(type(size) is int and 0 < size <= MAX_OBJECTS and all(obj < size for obj in entries))
                return trailer, entries, None
            first = parser.value()
            count = parser.value()
            fail(type(first) is int and type(count) is int and first >= 0 and count >= 0 and first + count <= MAX_OBJECTS)
            for obj in range(first, first + count):
                parser.skip()
                line_end = self.raw.find(b'\n', parser.pos, min(len(self.raw), parser.pos + 32))
                fail(line_end >= 0)
                line = self.raw[parser.pos:line_end].rstrip(b'\r')
                match = re.fullmatch(rb'(\d{10})\s(\d{5})\s([nf])\s?', line)
                fail(match is not None)
                fail(obj not in entries)
                entries[obj] = (1, int(match[1]), int(match[2])) if match[3] == b'n' else (0, int(match[1]), int(match[2]))
                parser.pos = line_end + 1

    def parse_xrefs(self):
        tail_start = len(self.raw) - min(len(self.raw), 65536)
        match = re.search(rb'startxref\s+(\d+)\s+%%EOF[\x00\x09\x0a\x0c\x0d\x20]*\Z', self.raw[tail_start:])
        fail(match is not None)
        offset = int(match[1])
        fail(offset > 0)
        seen = set()
        while offset is not None:
            fail(offset not in seen and len(seen) < 64)
            seen.add(offset)
            position = offset
            probe = Parser(self.raw, position)
            probe.skip()
            if self.raw.startswith(b'xref', probe.pos):
                dictionary, entries, xref_object = self.classic_xref(position)
            else:
                dictionary, entries, xref_object = self.xref_stream(position)
            # Hybrid-reference supplements need full precedence handling. Until
            # supported, reject rather than let MuPDF inspect unseen objects.
            fail(Name(b'XRefStm') not in dictionary)
            self.revisions.append((dictionary, entries, xref_object))
            previous = dictionary.get(Name(b'Prev'))
            fail(previous is None or (type(previous) is int and previous > 0))
            offset = previous
        fail(sum(len(entries) for _, entries, _ in self.revisions) <= MAX_OBJECTS * 4)

    def parse_objects(self):
        for dictionary, entries, xref_object in self.revisions:
            if xref_object is not None:
                number, offset = xref_object
                self.live.setdefault(number, (1, offset, 0))
            for number, entry in entries.items():
                self.live.setdefault(number, entry)
                if entry[0] != 1 or number == 0:
                    continue
                _, offset, generation = entry
                parsed_number, parsed_generation, value, payload = self.indirect(offset, (number, generation))
                key = (parsed_number, parsed_generation)
                self.values.setdefault(key, value)
                if payload is not None:
                    self.streams.setdefault(key, (value, payload))
        fail(len(self.live) <= MAX_OBJECTS)

    def parse_object_streams(self):
        compressed = {number: entry for number, entry in self.live.items() if entry[0] == 2}
        by_stream = {}
        for number, (kind, stream_number, index) in compressed.items():
            fail(kind == 2 and stream_number in self.live and self.live[stream_number][0] == 1 and index >= 0)
            by_stream.setdefault(stream_number, []).append((number, index))
        streams = {}
        for stream_number, references in by_stream.items():
            stream_entry = self.live[stream_number]
            stream_key = (stream_number, stream_entry[2])
            fail(stream_key in self.streams)
            dictionary, payload = self.streams[stream_key]
            fail(dictionary.get(Name(b'Type')) == Name(b'ObjStm'))
            n, first = dictionary.get(Name(b'N')), dictionary.get(Name(b'First'))
            fail(type(n) is int and 0 <= n <= MAX_OBJECTS and type(first) is int and first >= 0)
            decoded = self.decode_stream(dictionary, payload)
            fail(first <= len(decoded))
            header = Parser(decoded, 0, first)
            pairs = []
            for _ in range(n):
                obj, offset = header.value(), header.value()
                fail(type(obj) is int and obj > 0 and type(offset) is int and offset >= 0)
                pairs.append((obj, offset))
            header.skip()
            fail(header.pos == first and len({obj for obj, _ in pairs}) == n)
            fail(all(pairs[i][1] <= pairs[i + 1][1] for i in range(len(pairs) - 1)))
            for member_index, (obj, relative) in enumerate(pairs):
                end_relative = pairs[member_index + 1][1] if member_index + 1 < n else len(decoded) - first
                fail(relative <= end_relative and first + end_relative <= len(decoded))
                parser = Parser(decoded, first + relative, first + end_relative)
                value = parser.value()
                parser.skip()
                fail(parser.pos == first + end_relative)
                streams[(stream_number, member_index)] = (obj, value)
            for number, index in references:
                fail((stream_number, index) in streams and streams[(stream_number, index)][0] == number)
                self.values[(number, 0)] = streams[(stream_number, index)][1]

    def aliases(self):
        for start in self.values:
            current, seen, hops = start, set(), 0
            while isinstance(self.values.get(current), Ref):
                fail(current not in seen)
                seen.add(current)
                reference = self.values[current]
                fail(reference in self.values)
                hops += 1
                fail(hops <= MAX_ALIAS_HOPS)
                current = reference

    def validate(self):
        fail(self.raw.startswith(b'%PDF-') and len(self.raw) <= 25 * 1024 * 1024)
        self.parse_xrefs()
        self.parse_objects()
        self.parse_object_streams()
        self.aliases()


def validate_raw_pdf(raw):
    try:
        RawPdf(raw).validate()
    except Exception:
        raise ValueError(ERROR) from None
