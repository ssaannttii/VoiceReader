"""Prepared reading ("Lectura preparada"): deterministic rules.

Pure functions over a document's segments — no I/O, no model. They find

* **pauses** a narrator would make that sentence-by-sentence synthesis does not:
  after headings, at chapter ends and scene breaks, between paragraphs, after
  list items, around block quotes, around dialogue narrator tags (Spanish
  em-dash dialogue: ``—¿Sabes? —dijo—. No estoy seguro.``) and at a
  mid-sentence ellipsis;
* **changes** that are safe to make without judgement: Roman numerals in a
  strong context (``siglo XIX``, ``Capítulo IV``, ``Felipe II``), Spanish
  abbreviations the normalizer does not know (``p. ej.``, ``EE. UU.``,
  ``Sres.``), ordinals (``1.º``, ``2.ª``), numbers with units, currency,
  decimal commas and thousands dots, dates, clock times after an article,
  year ranges, words set in capitals that the document also uses in lower
  case, hyphenation left over from line breaks and stray ``<<`` marks;
* **candidates** that need judgement (an LLM, :mod:`services.reader_speech_llm`):
  Roman numerals without a strong context, capitalized acronyms, and names
  whose spelling a Spanish voice would read badly.

The display text is never changed: every change is a ``(c0, c1)`` span of the
segment's display text and what to *say* instead. :func:`build_spoken` turns
the stored changes and pauses of one segment into the pieces the renderer
synthesizes (``services.reader_render.Spoken``).

Everything here is conservative: when a rule is not sure it emits a candidate
or nothing. ``normalize_for_tts`` still runs after these changes at synthesis
time, so plain numbers, ``%`` and the abbreviations it knows are left to it.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable, Optional

#: Bump when the rules change what they produce (stored results are recomputed).
RULES_VERSION = 1

# ── Pauses ───────────────────────────────────────────────────────────────────

#: Reasons a user can switch off one by one (``pause_rules``).
PAUSE_REASONS = ("heading", "chapter", "scene", "paragraph", "dialogue", "list", "quote", "ellipsis")

#: Conservative durations (ms) of the silence each rule adds.
PAUSE_MS = {
    "heading": 700,
    "heading_run": 300,  # a heading followed by another one (tables of contents)
    "heading_prefix": 600,  # "1. el ejército…": after the chapter number
    "chapter": 1200,
    "scene": 500,  # before and after the break: ~1 s in total
    "paragraph": 200,
    "list": 250,
    "quote": 300,
    "dialogue_tag": 200,  # around a narrator tag
    "dialogue_turn": 350,  # another speaker in the same segment
    "ellipsis": 300,
}

#: A piece of speech shorter than this (letters) is merged into its neighbour
#: instead of being synthesized alone.
MIN_PIECE_LETTERS = 4

_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)
_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
_SCENE_BREAK_RE = re.compile(r"^\s*(?:[*#~•·⁂◆◇✦❖§]\s*){1,7}$|^\s*(?:[—–-]\s*){3,}$")
_SENTENCE_END = ".!?…"
_DASHES = "—―–"
_OPENERS = "«“\"'(¡¿"
_TITLE_PREFIX_RE = re.compile(
    r"^(?:(?:cap[ií]tulo|chapter|parte|part|libro|book)\s+)?(?:\d{1,3}|[IVXLCDM]{1,7})\.\s+(?=\S)"
    r"|^(?:pr[oó]logo|prefacio|ep[ií]logo|interludio|introducci[oó]n|agradecimientos|prologue|epilogue|"
    r"interlude|preface|introduction|acknowledgements)\.\s+(?=\S)",
    re.IGNORECASE,
)


@dataclass
class Change:
    """Say ``spoken`` for ``original`` (= display ``text[c0:c1]`` of ``segment``).

    ``scope='doc'`` (names) applies to every whole-word occurrence in the
    document; ``state`` is ``applied`` | ``suggested`` | ``reverted``.
    """

    segment: int
    c0: int
    c1: int
    original: str
    spoken: str
    kind: str
    source: str = "rule"
    state: str = "applied"
    scope: str = "here"
    count: int = 1


@dataclass
class Candidate:
    """A span that needs judgement; ``options`` maps a choice to what to say."""

    segment: int
    c0: int
    c1: int
    original: str
    kind: str  # roman | acronym | name
    context: str
    options: dict = field(default_factory=dict)
    count: int = 1


@dataclass
class Analysis:
    changes: list
    pauses: list  # [segment, at, ms, reason]
    candidates: list


# ── Language helpers ─────────────────────────────────────────────────────────


def lang_code(language: Optional[str]) -> str:
    value = (language or "").strip().lower()
    names = {"spanish": "es", "english": "en", "español": "es", "castellano": "es"}
    value = names.get(value, value)
    return value[:2]


def _num2words(n, **kw) -> str:
    from num2words import num2words

    return num2words(n, **kw)


def cardinal_es(n: int, *, feminine: bool = False, apocope: bool = False) -> str:
    words = _num2words(n, lang="es")
    if feminine:
        words = re.sub(r"uno\b", "una", words)
        words = re.sub(r"ientos\b", "ientas", words)
        words = words.replace("veintiún", "veintiuna")
    elif apocope:
        words = re.sub(r"veintiuno$", "veintiún", words)
        words = re.sub(r"uno$", "un", words)
    return words


def ordinal_es(n: int, *, feminine: bool = False, short: bool = False) -> str:
    words = _num2words(n, lang="es", to="ordinal")
    if feminine:
        words = " ".join(w[:-1] + "a" if w.endswith("o") else w for w in words.split())
    elif short:
        words = re.sub(r"(primer|tercer)o$", r"\1", words)
    return words


# ── Roman numerals ───────────────────────────────────────────────────────────

_ROMAN_VALUES = (
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
    (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
)
_ROMAN_RE = re.compile(r"(?<![\w.'’-])([IVXLCDM]{1,7})(?![\w'’-])")


def to_roman(n: int) -> str:
    out = []
    for value, symbol in _ROMAN_VALUES:
        while n >= value:
            out.append(symbol)
            n -= value
    return "".join(out)


def roman_value(token: str) -> Optional[int]:
    """Value of a canonical Roman numeral (``IIII`` and ``IC`` are rejected)."""
    if not token or any(ch not in "IVXLCDM" for ch in token):
        return None
    symbols = dict((s, v) for v, s in _ROMAN_VALUES if len(s) == 1)
    total, prev = 0, 0
    for ch in reversed(token):
        value = symbols[ch]
        total = total - value if value < prev else total + value
        prev = max(prev, value)
    if not 0 < total < 4000 or to_roman(total) != token:
        return None
    return total


_CENTURY_WORDS = {"siglo", "siglos", "century", "centuries"}
_SECTION_WORDS = {
    "capítulo", "capitulo", "parte", "libro", "tomo", "volumen", "vol.", "acto", "escena", "canto",
    "lección", "leccion", "tema", "sección", "seccion", "fase", "temporada", "episodio", "cap.",
    "chapter", "part", "book", "volume", "act", "scene", "section", "canto", "episode", "season",
}
_REGNAL_M = {
    "luis", "carlos", "felipe", "fernando", "alfonso", "juan", "pablo", "pío", "pio", "benedicto",
    "gregorio", "clemente", "inocencio", "urbano", "pedro", "jaime", "enrique", "jorge", "eduardo",
    "guillermo", "ricardo", "napoleón", "napoleon", "león", "leon", "sancho", "ramiro", "ramón",
    "alejandro", "nicolás", "nicolas", "federico", "otón", "oton", "constantino", "justiniano",
    "amadeo", "bonifacio", "sixto", "julio", "adriano", "martín", "martin", "calixto", "honorio",
    "eugenio", "esteban", "andrés", "manuel", "miguel", "basilio", "teodosio", "iván", "ivan",
    "rodolfo", "maximiliano", "francisco", "víctor", "victor", "humberto", "umberto", "gustavo",
    "cristián", "christian", "olaf", "harald", "haakon", "selim", "mehmed", "solimán", "ptolomeo",
    "ramsés", "ramses", "amenofis", "tutmosis", "antíoco", "seleuco", "darío", "dario", "jerjes",
    "artajerjes", "ciro", "mitrídates", "herodes", "lotario", "pipino", "berenguer", "ramon",
    "louis", "charles", "henry", "george", "edward", "william", "richard", "james", "john", "pius",
    "benedict", "gregory", "leo", "paul", "peter", "philip", "frederick", "alexander", "nicholas",
}
_REGNAL_F = {
    "isabel", "juana", "maría", "maria", "catalina", "victoria", "cristina", "leonor", "urraca",
    "berenguela", "margarita", "ana", "elizabeth", "mary", "anne", "catherine", "margaret",
}
#: Capital words that read as words or acronyms more often than as numbers.
_ROMAN_EXCLUDE = {"MI", "DI", "VI", "LI", "MIL", "DC", "CD", "MD", "CC", "CID", "DIM", "MIX", "VID", "LID", "XL", "XXL", "CV", "CI", "DCL"}


def _prev_word(text: str, c0: int) -> tuple[str, int]:
    """The token right before ``c0`` (with its punctuation) and where it starts."""
    m = re.search(r"(\S+)\s+$", text[:c0])
    if not m:
        return "", c0
    return m.group(1), m.start(1)


def _roman_rule(text: str, c0: int, c1: int, token: str, lang: str, whole: bool) -> Optional[tuple[int, str]]:
    """``(new c0, spoken)`` for a numeral with a strong context, else None."""
    value = roman_value(token)
    if value is None:
        return None
    prev, prev_start = _prev_word(text, c0)
    fold = prev.lower()
    if lang == "es":
        if fold in _CENTURY_WORDS:
            return c0, cardinal_es(value)
        if fold == "s." and value <= 21:
            return prev_start, "siglo " + cardinal_es(value)
        if fold in _SECTION_WORDS:
            return c0, cardinal_es(value)
        if prev[:1].isupper() and prev.isalpha() and (fold in _REGNAL_M or fold in _REGNAL_F):
            feminine = fold in _REGNAL_F
            if value <= 10:
                return c0, ordinal_es(value, feminine=feminine)
            return c0, cardinal_es(value)
        if whole:
            return c0, cardinal_es(value)
        return None
    if lang == "en":
        if fold in _SECTION_WORDS or (fold == "war" and text[:prev_start].rstrip().lower().endswith("world")):
            return c0, _num2words(value, lang="en")
        if fold in _CENTURY_WORDS:
            return None
        if prev[:1].isupper() and prev.isalpha() and (fold in _REGNAL_M or fold in _REGNAL_F) and token != "I":
            return c0, "the " + _num2words(value, lang="en", to="ordinal")
        if whole and token != "I":
            return c0, _num2words(value, lang="en")
    return None


def _roman_options(value: int, lang: str) -> dict:
    if lang == "es":
        options = {"cardinal": cardinal_es(value)}
        if value <= 10:  # Spanish reads regnal numbers above ten as cardinals
            options["ordinal"] = ordinal_es(value)
            options["ordinal_f"] = ordinal_es(value, feminine=True)
        return options
    return {"cardinal": _num2words(value, lang="en"), "ordinal": "the " + _num2words(value, lang="en", to="ordinal")}


# ── Abbreviations, ordinals, quantities, dates, times (Spanish) ──────────────

_CAP_AHEAD = r"(?=\s+[A-ZÁÉÍÓÚÑÜ])"
_NOT_CAP_AHEAD = r"(?!\s+[A-ZÁÉÍÓÚÑÜ])"
_DIGIT_AHEAD = r"(?=\s*\d)"
_B = r"(?<![\w.])"

#: ``(pattern, spoken)``; the normalizer already expands Sr./Sra./Srta./Dr./Dra.
#: before a capital, Ud./Uds., etc., núm. — those are left to it.
_ABBREVIATIONS_ES = [
    (_B + r"p\.\s?ej\.", "por ejemplo"),
    (_B + r"(?:EE\.\s?UU\.|EEUU\b|EE\.UU\b)", "Estados Unidos"),
    (_B + r"págs\." + _DIGIT_AHEAD, "páginas"),
    (_B + r"pág\." + _DIGIT_AHEAD, "página"),
    (_B + r"pp\." + _DIGIT_AHEAD, "páginas"),
    (_B + r"[nN]\.?\s?º" + _DIGIT_AHEAD, "número"),
    (_B + r"Sr\." + _NOT_CAP_AHEAD, "señor"),
    (_B + r"Sra\." + _NOT_CAP_AHEAD, "señora"),
    (_B + r"Srta\." + _NOT_CAP_AHEAD, "señorita"),
    (_B + r"Dr\." + _NOT_CAP_AHEAD, "doctor"),
    (_B + r"Dra\." + _NOT_CAP_AHEAD, "doctora"),
    (_B + r"Sres\.", "señores"),
    (_B + r"Sras\.", "señoras"),
    (_B + r"(?:Dña\.|D\.ª|Dª)", "doña"),
    (_B + r"Sto\." + _CAP_AHEAD, "santo"),
    (_B + r"Sta\." + _CAP_AHEAD, "santa"),
    (_B + r"Excmo\.", "excelentísimo"),
    (_B + r"Excma\.", "excelentísima"),
    (_B + r"Ilmo\.", "ilustrísimo"),
    (_B + r"Ilma\.", "ilustrísima"),
    (_B + r"Gral\.", "general"),
    (_B + r"Cnel\.", "coronel"),
    (_B + r"Tte\.", "teniente"),
    (_B + r"Mons\.", "monseñor"),
    (_B + r"Lic\." + _CAP_AHEAD, "licenciado"),
    (_B + r"Ing\." + _CAP_AHEAD, "ingeniero"),
    (_B + r"Prof\." + _NOT_CAP_AHEAD, "profesor"),
    (_B + r"Profa\.", "profesora"),
    (_B + r"Avda\.", "avenida"),
    (_B + r"Cía\.", "compañía"),
    (_B + r"Hnos\.", "hermanos"),
    (_B + r"aprox\.", "aproximadamente"),
    (_B + r"vol\." + _DIGIT_AHEAD, "volumen"),
    (_B + r"cap\." + _DIGIT_AHEAD, "capítulo"),
    (_B + r"fig\." + _DIGIT_AHEAD, "figura"),
    (_B + r"art\." + _DIGIT_AHEAD, "artículo"),
    (r"(?<=\d)\s+a\.\s?(?:de\s)?C\.", " antes de Cristo"),
    (r"(?<=\d)\s+d\.\s?(?:de\s)?C\.", " después de Cristo"),
]
_ABBREVIATIONS_ES = [(re.compile(p), s) for p, s in _ABBREVIATIONS_ES]

_ORDINAL_RE = re.compile(r"(?<![\w.,])(\d{1,3})(?:\.(º|ª|er|ᵉʳ)|(º|ª))(?![\w])")

_MONTHS_ES = (
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
    "octubre", "noviembre", "diciembre",
)
_DATE_RE = re.compile(r"(?<![\w./-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?![\w]|[./-]\d)")
_TIME_RE = re.compile(
    r"\b((?:a|de|desde|hasta|sobre|hacia|para)\s+las?|las?)\s+(\d{1,2}):(\d{2})(?:\s?h\b\.?)?(?![\d:])",
    re.IGNORECASE,
)
_YEAR_RANGE_RE = re.compile(r"(?<![\w.,-])(1\d{3}|20\d{2})\s?[-–]\s?(1\d{3}|20\d{2})(?![\w]|[.,]\d)")

#: unit → (singular, plural, feminine)
_UNITS_ES = {
    "%": ("por ciento", "por ciento", False),
    "€": ("euro", "euros", False),
    "$": ("dólar", "dólares", False),
    "£": ("libra", "libras", True),
    "km/h": ("kilómetro por hora", "kilómetros por hora", False),
    "km": ("kilómetro", "kilómetros", False),
    "kg": ("kilo", "kilos", False),
    "cm": ("centímetro", "centímetros", False),
    "mm": ("milímetro", "milímetros", False),
    "mg": ("miligramo", "miligramos", False),
    "ml": ("mililitro", "mililitros", False),
    "m": ("metro", "metros", False),
    "g": ("gramo", "gramos", False),
    "h": ("hora", "horas", True),
    "min": ("minuto", "minutos", False),
    "°C": ("grado", "grados", False),
    "ºC": ("grado", "grados", False),
    "°": ("grado", "grados", False),
}
_CURRENCY = ("€", "$", "£")
_QUANTITY_RE = re.compile(
    r"(?<![\w.,])(?P<pre>[$£€]\s?)?(?P<int>\d{1,3}(?:\.\d{3})+|\d{1,7})(?:,(?P<frac>\d{1,3}))?(?![\d.,]\d)"
    r"(?:(?P<sp>\s?)(?P<unit>km/h|km|kg|cm|mm|mg|ml|min|°C|ºC|°|%|€|\$|£|m|g|h)(?![\w/]))?"
)


def _quantity_es(m: re.Match) -> Optional[str]:
    pre = (m.group("pre") or "").strip()
    raw_int = m.group("int")
    frac = m.group("frac")
    unit = m.group("unit") or ""
    thousands = "." in raw_int
    if pre and unit:
        return None
    unit = pre or unit
    if not unit and not frac and not thousands:
        return None  # plain integer: the normalizer reads it
    if unit == "%" and not frac and not thousands:
        return None  # the normalizer reads "50 %"
    if unit in ("m", "g", "h", "min") and not m.group("sp") and not frac:
        return None  # "3m", "5g": product codes as often as quantities
    try:
        n = int(raw_int.replace(".", ""))
    except ValueError:
        return None
    if len(raw_int.replace(".", "")) > 1 and raw_int.startswith("0"):
        return None
    singular, plural, feminine = _UNITS_ES.get(unit, ("", "", False))
    if frac is not None:
        if unit in _CURRENCY and len(frac) == 2:
            cents = int(frac)
            words = cardinal_es(n, feminine=feminine, apocope=not feminine) + " " + (singular if n == 1 else plural)
            if cents:
                words += " con " + cardinal_es(cents)
            return words
        frac_words = (
            " ".join(cardinal_es(int(d)) for d in frac) if frac.startswith("0") else cardinal_es(int(frac))
        )
        words = cardinal_es(n) + " coma " + frac_words
        return words + (" " + plural if unit else "")
    if not unit:
        return cardinal_es(n)
    if unit == "%":
        return cardinal_es(n) + " por ciento"
    words = cardinal_es(n, feminine=feminine, apocope=not feminine)
    return words + " " + (singular if n == 1 else plural)


def _date_es(m: re.Match) -> Optional[str]:
    day, month, year = int(m.group(1)), int(m.group(3)), int(m.group(4))
    if not (1 <= day <= 31 and 1 <= month <= 12 and 1000 <= year <= 2199):
        return None
    return f"{cardinal_es(day)} de {_MONTHS_ES[month - 1]} de {_num2words(year, lang='es', to='year')}"


def _time_es(m: re.Match) -> Optional[str]:
    hour, minute = int(m.group(2)), int(m.group(3))
    if hour > 24 or minute > 59:
        return None
    words = cardinal_es(hour, feminine=True) if hour else "cero"
    words += " en punto" if minute == 0 else " y " + cardinal_es(minute)
    return f"{m.group(1)} {words}"


def _year_range(m: re.Match) -> str:
    a, b = int(m.group(1)), int(m.group(2))
    return f"{_num2words(a, lang='es', to='year')} a {_num2words(b, lang='es', to='year')}"


# ── Capitals, acronyms, names ────────────────────────────────────────────────

_LETTERS_ES = {
    "A": "a", "B": "be", "C": "ce", "D": "de", "E": "e", "F": "efe", "G": "ge", "H": "hache",
    "I": "i", "J": "jota", "K": "ka", "L": "ele", "M": "eme", "N": "ene", "Ñ": "eñe", "O": "o",
    "P": "pe", "Q": "cu", "R": "erre", "S": "ese", "T": "te", "U": "u", "V": "uve", "W": "uve doble",
    "X": "equis", "Y": "i griega", "Z": "zeta",
}
#: Common Spanish acronyms and how they are said.
_ACRONYMS_ES = {
    "ONU": "ONU", "OTAN": "OTAN", "UE": "u e", "FBI": "efe be i", "CIA": "cía", "DNI": "de ene i",
    "ADN": "a de ene", "ONG": "o ene ge", "IVA": "iva", "PIB": "pib", "NASA": "nasa", "UNESCO": "unesco",
    "OMS": "o eme ese", "UCI": "uci", "TV": "tele", "PC": "pecé", "CD": "cedé", "DVD": "de uve de",
    "USB": "u ese be", "GPS": "ge pe ese", "EEUU": "Estados Unidos", "URSS": "urss", "ETA": "eta",
    "RAE": "rae", "BBC": "be be ce", "CNN": "ce ene ene", "SMS": "ese eme ese", "ONCE": "once",
}
_CAPS_TOKEN_RE = re.compile(r"(?<![\w'’])[A-ZÁÉÍÓÚÑÜ]+(?![\w'’])")
_VOWELS = set("AEIOUÁÉÍÓÚÜaeiouáéíóúü")
_FOREIGN_RE = re.compile(
    r"sh|th|w|k|ck|ph|ff|ss|tt|pp|dd|gg|bb|zz|nn|oo|ee|ou|eu|aa|y(?=[^aeiouáéíóú\W])|^s(?=[bcdfgkmnpqtvwz])"
    r"|[bcdfgkmpqtvwxz][bcdfgkmpqstvwxz]$|(?-i:^[A-Z][a-z]+[A-Z])",
    re.IGNORECASE,
)


#: Accents and ñ only occur in Spanish spelling: such a word is not foreign.
_SPANISH_MARKS_RE = re.compile(r"[áéíóúñü]", re.IGNORECASE)


def spell_es(token: str) -> str:
    return " ".join(_LETTERS_ES.get(ch, ch.lower()) for ch in token.upper())


@dataclass
class Corpus:
    """Word forms of the whole document: tells words from names and acronyms."""

    forms: dict  # casefold → Counter of non-capitalized-only forms (lower or Title)
    lower: set  # words seen in lower case
    counts: Counter

    @classmethod
    def build(cls, texts: Iterable[str]) -> "Corpus":
        counts: Counter = Counter()
        for text in texts:
            counts.update(_WORD_RE.findall(text or ""))
        forms: dict = {}
        lower = set()
        for word, n in counts.items():
            if word.islower():
                lower.add(word)
            if len(word) > 1 and word.isupper():
                continue
            forms.setdefault(word.casefold(), Counter())[word] += n
        return cls(forms=forms, lower=lower, counts=counts)

    def word_form(self, token: str) -> Optional[str]:
        """How the document writes ``token`` when not in capitals, if it does."""
        found = self.forms.get(token.casefold())
        return found.most_common(1)[0][0] if found else None


# ── Dialogue ─────────────────────────────────────────────────────────────────


def _prev_non_space(text: str, pos: int) -> int:
    pos -= 1
    while pos >= 0 and text[pos].isspace():
        pos -= 1
    return pos


def _sentence_start(text: str, pos: int) -> bool:
    """Does a sentence (or a character's line) start at ``pos``?"""
    prev = _prev_non_space(text, pos)
    while prev >= 0 and text[prev] in _OPENERS:
        prev = _prev_non_space(text, prev)
    if prev >= 0 and text[prev] in _DASHES:
        # A dash opens a line at the start or after a sentence; else it opens
        # a narrator tag ("—Bien —dijo Vin"), which starts in lower case.
        before = _prev_non_space(text, prev)
        return before < 0 or text[before] in _SENTENCE_END
    return prev < 0 or text[prev] in _SENTENCE_END + ":"


def dialogue_marks(text: str) -> tuple[list, list]:
    """``(edits, cuts)`` for em-dash dialogue and parentheticals.

    ``edits`` are ``(c0, c1, replacement)``: the dashes are not read; a dash
    between words becomes a comma. ``cuts`` are ``(at, ms, reason)``: a short
    pause before a narrator tag (``—dijo``), after it (``—.``) and before
    another speaker's turn in the same segment (``. —Sí``).
    """
    edits: list = []
    cuts: list = []
    if text.startswith("»"):
        edits.append((0, 1, ""))
    for m in re.finditer(f"[{_DASHES}]", text):
        p = m.start()
        before = text[p - 1] if p else ""
        after = text[p + 1] if p + 1 < len(text) else ""
        if before.isdigit() and after.isdigit():
            continue  # a range: 1990–1995
        if text[p] == "–" and not (before.isspace() or not before) and not after.isspace():
            continue  # en dash inside a word or range
        prev = _prev_non_space(text, p)
        if not before or before.isspace() or before in _OPENERS:
            if after.isspace() or not after:
                # A free-standing dash between clauses: " — ".
                if prev >= 0 and text[p + 1:].strip():
                    edits.append((p, p + 1, ","))
                    cuts.append((p, PAUSE_MS["dialogue_tag"], "dialogue"))
                else:
                    edits.append((p, p + 1, ""))
                continue
            # "Era —pensó—": the clause before the tag reads with a comma.
            edits.append((p, p + 1, ", " if prev >= 0 and text[prev].isalnum() else ""))
            if prev < 0 or text[: p].strip() in ("»", "«"):
                continue  # opens the segment
            if text[prev] in _SENTENCE_END and (after.isupper() or after in "¿¡«"):
                cuts.append((p, PAUSE_MS["dialogue_turn"], "dialogue"))
            else:
                cuts.append((p, PAUSE_MS["dialogue_tag"], "dialogue"))
            continue
        # Closing dash, glued to the word before it.
        if after.isalpha():
            edits.append((p, p + 1, ", "))  # interrupted word—word
            continue
        j = p + 1
        while j < len(text) and text[j] in ".,;:!?…":
            j += 1
        rest = text[j:].strip()
        if j == p + 1 and rest and rest[0] not in _DASHES:
            edits.append((p, p + 1, ","))
        else:
            edits.append((p, p + 1, ""))
        if rest:
            cuts.append((j, PAUSE_MS["dialogue_tag"], "dialogue"))
    return edits, cuts


def ellipsis_cuts(text: str) -> tuple[list, bool]:
    """Mid-segment ``…`` followed by more text → pause; and whether the
    segment ends with one."""
    cuts = []
    for m in re.finditer(r"…|\.\.\.(?!\.)", text):
        if m.start() == 0:
            continue
        j = m.end()
        while j < len(text) and text[j] in "»”\"’)":
            j += 1
        if j < len(text) and text[j].isspace() and _LETTER_RE.search(text[j:]):
            cuts.append((j, PAUSE_MS["ellipsis"], "ellipsis"))
    tail = text.rstrip(" »”\"’)")
    return cuts, tail.endswith("…") or tail.endswith("...")


# ── Analysis ─────────────────────────────────────────────────────────────────


def _segment_changes(text: str, segment: int, lang: str, corpus: Corpus, *, whole_heading: bool) -> tuple[list, list]:
    """``(changes, candidates)`` for one segment's display text."""
    found: list = []  # (c0, c1, spoken, kind)
    candidates: list = []

    def add(c0: int, c1: int, spoken: Optional[str], kind: str) -> None:
        if spoken is None or spoken == text[c0:c1]:
            return
        found.append((c0, c1, spoken, kind))

    if lang == "es":
        for pattern, spoken in _ABBREVIATIONS_ES:
            for m in pattern.finditer(text):
                add(m.start(), m.end(), spoken, "abbr")
        for m in _ORDINAL_RE.finditer(text):
            n = int(m.group(1))
            mark = m.group(2) or m.group(3)
            add(m.start(), m.end(), ordinal_es(n, feminine=mark == "ª", short=mark in ("er", "ᵉʳ")), "ordinal")
        for m in _DATE_RE.finditer(text):
            add(m.start(), m.end(), _date_es(m), "date")
        for m in _TIME_RE.finditer(text):
            add(m.start(), m.end(), _time_es(m), "time")
        for m in _YEAR_RANGE_RE.finditer(text):
            add(m.start(), m.end(), _year_range(m), "date")
        for m in _QUANTITY_RE.finditer(text):
            add(m.start(), m.end(), _quantity_es(m), "number")
        for m in re.finditer(r"([^\W\d_]{2,})-\s+([^\W\d_]{2,})", text):
            first, second = m.group(1), m.group(2)
            if not second.islower() or second in ("y", "e", "o", "u", "ni"):
                continue
            joined = first + second
            # Halves that are not words elsewhere in the document (each is
            # seen here once) are the two ends of one word.
            stray = corpus.counts[first] <= 1 and corpus.counts[second] <= 1
            if joined.casefold() in corpus.forms or stray:
                add(m.start(), m.end(), joined, "hyphen")
    for m in re.finditer("­", text):
        add(m.start(), m.end(), "", "hyphen")
    for m in re.finditer(r"(?:(?<=\s)|^)(?:<<|>>)(?=\s|$)", text):
        add(m.start(), m.end(), "", "symbol")

    # Roman numerals with a strong context.
    roman_done: set = set()
    if lang in ("es", "en"):
        for m in _ROMAN_RE.finditer(text):
            token = m.group(1)
            ruled = _roman_rule(text, m.start(), m.end(), token, lang, whole_heading and text.strip(" .:") == token)
            if ruled is not None:
                add(ruled[0], m.end(), ruled[1], "roman")
                roman_done.add(m.start())

    # Capitals: runs of words in capitals, acronyms, leftover numerals.
    prose = len(re.findall(r"\b[a-záéíóúñü]{2,}\b", text))
    tokens = list(_CAPS_TOKEN_RE.finditer(text))
    runs: list = []
    for tok in tokens:
        if runs and re.fullmatch(r"[\s,;:.'’]*", text[runs[-1][-1].end():tok.start()]) is not None \
                and not re.search(r"[.;:]", text[runs[-1][-1].end():tok.start()]):
            runs[-1].append(tok)
        else:
            runs.append([tok])
    for run in runs:
        long_words = [t for t in run if len(t.group(0)) >= 2]
        if not long_words or (len(run) == 1 and run[0].start() in roman_done):
            continue
        if len(long_words) >= 2 or len(run) >= 2:
            # A run in capitals (small-caps chapter openings, titles): read it in
            # the case the document uses elsewhere when every word is known.
            pieces = []
            known = 0
            for t in run:
                word = t.group(0)
                form = corpus.word_form(word)
                if form is None and len(word) == 1:
                    form = word.lower()
                if form is None:
                    break
                known += len(word) >= 2
                pieces.append((t, form))
            else:
                if known:
                    c0, c1 = run[0].start(), run[-1].end()
                    out = text[c0:c1]
                    for t, form in reversed(pieces):
                        out = out[: t.start() - c0] + form + out[t.end() - c0:]
                    if _sentence_start(text, c0):
                        out = out[:1].upper() + out[1:]
                    add(c0, c1, out, "caps")
                    continue
            if lang == "es" and len(run) >= 2:
                continue  # a run with unknown words: leave it
        for t in run:
            word = t.group(0)
            if len(word) < 2 or t.start() in roman_done:
                continue
            form = corpus.word_form(word)
            value = roman_value(word)
            if value is not None and word not in _ROMAN_EXCLUDE and form is None and lang in ("es", "en"):
                prev, _ = _prev_word(text, t.start())
                if prev[:1].isupper() or len(word) >= 3:
                    candidates.append(Candidate(segment, t.start(), t.end(), word, "roman", text,
                                                _roman_options(value, lang)))
                continue
            if form is not None:
                if _sentence_start(text, t.start()):
                    form = form[:1].upper() + form[1:]
                add(t.start(), t.end(), form, "caps")
                continue
            if lang != "es" or len(word) > 6:
                continue
            if word in _ACRONYMS_ES:
                if _ACRONYMS_ES[word] != word:
                    add(t.start(), t.end(), _ACRONYMS_ES[word], "acronym")
                continue
            if not any(ch in _VOWELS for ch in word):
                add(t.start(), t.end(), spell_es(word), "acronym")
                continue
            if prose < 3 or text[t.end():].lstrip()[:1] == ":":
                continue  # titles, glossary entries, drop-cap leftovers ("S TRAFF")
            candidates.append(Candidate(segment, t.start(), t.end(), word, "acronym", text, {
                "word": word[:1] + word[1:].lower(), "spell": spell_es(word), "keep": word,
            }))

    # Resolve overlaps: earliest first, longest first.
    found.sort(key=lambda f: (f[0], -(f[1] - f[0])))
    changes: list = []
    end = -1
    for c0, c1, spoken, kind in found:
        if c0 < end:
            continue
        changes.append(Change(segment, c0, c1, text[c0:c1], spoken, kind))
        end = c1
    taken = [(c.c0, c.c1) for c in changes]
    candidates = [c for c in candidates if not any(a < c.c1 and c.c0 < b for a, b in taken)]
    return changes, candidates


def name_candidates(segments: list, corpus: Corpus, *, limit: int = 80, min_count: int = 2) -> list:
    """Names a Spanish voice may read badly: capitalized, never written in
    lower case in this document, recurring, with a spelling Spanish does not
    use (``sh``, ``th``, ``w``, ``k``, doubled consonants…). One candidate per
    name, at its first occurrence."""
    names = [
        (word, n) for word, n in corpus.counts.items()
        if n >= min_count and len(word) >= 3 and word[:1].isupper() and not word.isupper()
        and word.lower() not in corpus.lower and not _SPANISH_MARKS_RE.search(word) and _FOREIGN_RE.search(word)
    ]
    names.sort(key=lambda item: -item[1])
    wanted = {word: n for word, n in names[:limit]}
    out: list = []
    seen: set = set()
    for seg in segments:
        text = seg.get("text") or ""
        for m in _WORD_RE.finditer(text):
            word = m.group(0)
            if word in wanted and word not in seen:
                seen.add(word)
                out.append(Candidate(seg["i"] if "i" in seg else 0, m.start(), m.end(), word, "name", text,
                                     count=wanted[word]))
        if len(seen) == len(wanted):
            break
    return out


def analyze(
    segments: list, chapters: list, language: Optional[str], *, names: bool = True, corpus: Optional[Corpus] = None
) -> Analysis:
    """Rules over a whole document (``content.json`` segments + chapters)."""
    lang = lang_code(language)
    corpus = corpus or Corpus.build(s.get("text") or "" for s in segments)
    starts = sorted({int(c.get("segment", 0)) for c in chapters or []})
    start_set = set(starts)
    pauses: list = []
    changes: list = []
    candidates: list = []
    count = len(segments)

    def pause(index: int, at: int, ms: int, reason: str) -> None:
        pauses.append([index, at, ms, reason])

    # Chapter ends: the last segment of a chapter with some body.
    for k, start in enumerate(starts):
        if start <= 0 or start > count:
            continue
        prev_start = starts[k - 1] if k else 0
        if start - prev_start >= 3:
            last = start - 1
            pause(last, len(segments[last].get("text") or ""), PAUSE_MS["chapter"], "chapter")

    for index, seg in enumerate(segments):
        text = seg.get("text") or ""
        kind = seg.get("kind") or "p"
        n = len(text)
        if kind == "img" or not text.strip():
            continue
        nxt = segments[index + 1] if index + 1 < count else None
        if _SCENE_BREAK_RE.match(text):
            pause(index, 0, PAUSE_MS["scene"], "scene")
            pause(index, n, PAUSE_MS["scene"], "scene")
            continue
        if kind == "h":
            ms = PAUSE_MS["heading_run"] if nxt is not None and nxt.get("kind") == "h" else PAUSE_MS["heading"]
            pause(index, n, ms, "heading")
        elif index in start_set:
            m = _TITLE_PREFIX_RE.match(text)
            if m and m.end() < n:
                pause(index, m.end(), PAUSE_MS["heading_prefix"], "heading")
        if kind == "li":
            pause(index, n, PAUSE_MS["list"], "list")
        elif kind == "quote":
            prev = segments[index - 1] if index else None
            if prev is None or prev.get("kind") != "quote":
                pause(index, 0, PAUSE_MS["quote"], "quote")
            if nxt is None or nxt.get("kind") != "quote":
                pause(index, n, PAUSE_MS["quote"], "quote")
        elif kind == "p" and nxt is not None and nxt.get("para") != seg.get("para"):
            pause(index, n, PAUSE_MS["paragraph"], "paragraph")
        _edits, cuts = dialogue_marks(text)
        for at, ms, reason in cuts:
            pause(index, at, ms, reason)
        mid, ends = ellipsis_cuts(text)
        for at, ms, reason in mid:
            pause(index, at, ms, reason)
        if ends and kind != "h":
            pause(index, n, PAUSE_MS["ellipsis"], "ellipsis")
        whole = kind == "h" or index in start_set
        seg_changes, seg_candidates = _segment_changes(text, index, lang, corpus, whole_heading=whole)
        changes.extend(seg_changes)
        candidates.extend(seg_candidates)
    if names and lang == "es":
        indexed = [dict(s, i=k) for k, s in enumerate(segments)]
        candidates.extend(name_candidates(indexed, corpus))
    return Analysis(changes=changes, pauses=pauses, candidates=candidates)


# ── Building what to say ─────────────────────────────────────────────────────


def _letters(text: str) -> int:
    return len(_LETTER_RE.findall(text))


def _tidy(text: str) -> str:
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:!?…»”)])", r"\1", text)
    text = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", text)
    text = re.sub(r"^[\s,;:]+", "", text)
    return text.strip()


def _join(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left
    if left[-1] in ",.;:!?…»”)":
        return f"{left} {right}"
    return f"{left}, {right}"


def build_spoken(
    text: str,
    *,
    changes: Iterable = (),
    pauses: Iterable = (),
    names: Optional[dict] = None,
    rules: Optional[dict] = None,
) -> Optional[tuple[int, tuple]]:
    """``(lead_ms, pieces)`` to synthesize for one segment, or ``None`` when
    the prepared reading is the same as the plain one.

    ``changes``: ``(c0, c1, spoken)`` spans applied here; ``pauses``:
    ``(at, ms, reason)``; ``names``: whole-word ``{name: spoken}`` applied
    anywhere; ``rules``: ``{reason: enabled}`` (missing = enabled; the
    ``dialogue`` rule also controls the dash edits). ``pieces`` are
    ``(c0, c1, spoken, pause_ms_after)`` covering the display text in order.
    """
    rules = rules or {}
    on = lambda reason: rules.get(reason, True) is not False  # noqa: E731
    n = len(text)
    edits = [(int(c0), int(c1), str(s)) for c0, c1, s in changes]
    if on("dialogue"):
        dash_edits, _ = dialogue_marks(text)
        edits.extend(dash_edits)
    if names:
        pattern = re.compile(r"(?<![\w])(" + "|".join(re.escape(k) for k in sorted(names, key=len, reverse=True)) + r")(?![\w])")
        for m in pattern.finditer(text):
            edits.append((m.start(), m.end(), names[m.group(1)]))
    edits.sort(key=lambda e: (e[0], -(e[1] - e[0])))
    clean: list = []
    end = -1
    for c0, c1, s in edits:
        if c0 < end or c0 < 0 or c1 > n:
            continue
        clean.append((c0, c1, s))
        end = max(end, c1)
    lead = trail = 0
    mids: dict = {}
    for at, ms, reason in pauses:
        if not on(reason):
            continue
        at, ms = int(at), int(ms)
        if at <= 0:
            lead = max(lead, ms)
        elif at >= n:
            trail = max(trail, ms)
        elif not any(c0 < at < c1 for c0, c1, _ in clean):
            mids[at] = max(mids.get(at, 0), ms)
    # Cuts separated only by spaces/punctuation are one pause (the later spot).
    cuts: list = []
    for at in sorted(mids):
        if cuts and not re.search(r"[\w]", text[cuts[-1][0]:at]):
            cuts[-1] = (at, max(cuts[-1][1], mids[at]))
        else:
            cuts.append((at, mids[at]))
    bounds = [0] + [at for at, _ in cuts] + [n]
    pieces: list = []
    for k in range(len(bounds) - 1):
        a, b = bounds[k], bounds[k + 1]
        out, pos = [], a
        for c0, c1, s in clean:
            if c0 >= a and c1 <= b:
                out.append(text[pos:c0])
                out.append(s)
                pos = c1
        out.append(text[pos:b])
        pause_after = cuts[k][1] if k < len(cuts) else trail
        said = _tidy("".join(out))
        if not re.search(r"\w", said):
            said = ""  # "* * *", "—": nothing to say
        pieces.append([a, b, said, pause_after])
    # Pieces too short to synthesize well merge into a neighbour.
    k = 0
    while len(pieces) > 1 and k < len(pieces):
        if _letters(pieces[k][2]) >= MIN_PIECE_LETTERS:
            k += 1
            continue
        if k + 1 < len(pieces):
            left, right = pieces[k], pieces.pop(k + 1)
            pieces[k] = [left[0], right[1], _join(left[2], right[2]), right[3]]
        else:
            left, right = pieces[k - 1], pieces.pop(k)
            pieces[k - 1] = [left[0], right[1], _join(left[2], right[2]), right[3]]
            k -= 1
    result = tuple((a, b, s, ms) for a, b, s, ms in pieces)
    if not lead and len(result) == 1 and not result[0][3] and result[0][2] == _tidy(text):
        return None
    return lead, result
