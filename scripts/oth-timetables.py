"""
Builds the OTH Amberg-Weiden timetable data from the university's published PDFs.

    pip install pymupdf
    python scripts/oth-timetables.py            # writes resources/oth-timetables.json, oth-exams.json,
                                                #        OTH_Timetable_Documents.jsonl, OTH_Exams.jsonl, OTH_Document_Index.jsonl

Development-time tool only (the app itself needs no Python): it reads the public
"Stundenplan" PDFs linked from the university's timetable page and turns every
class grid (Untis export) into events with a weekday, a start and end time and the
text printed in the box: course, room, lecturer. It also keeps the text of the other
published PDFs (exam plans, lecture hall allocation) as knowledge records.

Only /files/ is read, never /fileadmin/ (disallowed by robots.txt), one request at a time.
Run it again when the university publishes a new semester.
"""
import hashlib
import json
import re
import sys
import time
import urllib.request
from datetime import date
from html import unescape
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
HOST = "https://www.oth-aw.de"
UA = "CampusOS-OTH-pack/1.0 (student project, private; https://github.com/nightsharkux/CampusOS_One)"
PLAN_PAGES = [
    f"{HOST}/studium/im-studium/organisatorisches/stunden-und-pruefungsplaene/",
    f"{HOST}/en/studies/getting-started/university-formalties/timetables-and-examination-schedules/",
]
CACHE = ROOT / "storage" / "oth-crawl" / "pdf"
DAYS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
DAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
TODAY = date.today().isoformat()
DELAY = 0.8


def fetch(url, binary=False):
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=40) as res:
                data = res.read()
            time.sleep(DELAY)
            return data if binary else data.decode("utf-8", "replace")
        except Exception as error:  # noqa: BLE001
            if attempt == 3:
                print("  failed", url, error, file=sys.stderr)
                return None
            time.sleep(2 * (attempt + 1))
    return None


def cached_pdf(url):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".pdf")
    if not path.exists():
        data = fetch(url, binary=True)
        if not data or not data.startswith(b"%PDF"):
            return None
        path.write_bytes(data)
    return path


def plan_links():
    """[(label, url)] for every PDF linked from the timetable pages."""
    found = {}
    for page in PLAN_PAGES:
        html = fetch(page) or ""
        for m in re.finditer(r'<a\b[^>]*href="(/files/[^"]+\.pdf)"[^>]*>(.*?)</a>', html, re.S | re.I):
            url = HOST + unescape(m.group(1))
            label = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", m.group(2)))).strip()
            found.setdefault(url, label)
    return list(found.items())


def programme_from_url(url):
    m = re.search(r"/Studiengaenge/(Bachelor|Master)/([A-Za-z0-9_-]+)/", url)
    return (m.group(2), m.group(1)) if m else (None, None)


# ---------------------------------------------------------------- grid pages

def clock(text):
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", text.strip())
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


def lines_of(page):
    """Text lines with their visual bounding boxes (the page rotation is applied)."""
    out = []
    matrix = page.rotation_matrix
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            text = re.sub(r"[\x00-\x1f�]+", " ", "".join(span["text"] for span in line["spans"])).strip()
            if not text:
                continue
            rect = pymupdf.Rect(line["bbox"]) * matrix
            out.append((rect, text))
    return out


def text_cells(lines, day_x, col_w, periods):
    """Grids drawn as plain cells: the text of an event sits inside its day column and period row."""
    tops = [p["y0"] - 3 for p in periods]
    bottoms = tops[1:] + [tops[-1] + (tops[-1] - tops[-2])]
    left = min(day_x.values()) - col_w / 2
    cells = {}
    for rect, text in lines:
        cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
        if cx < left or cx > max(day_x.values()) + col_w / 2:
            continue
        row = next((i for i, (t, b) in enumerate(zip(tops, bottoms)) if t <= cy < b), None)
        if row is None or re.search(r"Untis|Seite \d", text):
            continue
        day = min(day_x, key=lambda i: abs(day_x[i] - cx))
        cells.setdefault((day, row), []).append((rect, text))
    events = []
    for (day, row), items in cells.items():
        # Side-by-side events in one cell: lines whose centres are close in x belong together.
        items.sort(key=lambda x: (x[0].x0 + x[0].x1) / 2)
        groups = []
        for rect, text in items:
            cx = (rect.x0 + rect.x1) / 2
            if groups and abs(cx - groups[-1]["cx"]) < col_w * 0.16:
                groups[-1]["items"].append((rect, text))
                groups[-1]["cx"] = (groups[-1]["cx"] + cx) / 2
            else:
                groups.append({"cx": cx, "items": [(rect, text)]})
        for g in groups:
            g["items"].sort(key=lambda x: x[0].y0)
            texts = [t for _, t in g["items"]]
            joined = " | ".join(texts)
            fmt = "online" if re.search(r"\bonline\b", joined, re.I) else "hybrid" if re.search(r"hybrid", joined, re.I) else "in person"
            events.append({"day": day, "start": periods[row]["start"], "end": periods[row]["end"], "lines": texts, "text": " · ".join(texts), "format": fmt})
    # A lecture that runs over two neighbouring periods is printed in both.
    events.sort(key=lambda e: (e["day"], e["text"], e["start"]))
    merged = []
    for e in events:
        last = merged[-1] if merged else None
        if last and last["day"] == e["day"] and last["text"] == e["text"] and last["end"] <= e["start"] and e["start"] <= next_start(periods, last["end"]):
            last["end"] = e["end"]
        else:
            merged.append(dict(e))
    return merged


def next_start(periods, end):
    later = [p["start"] for p in periods if p["start"] >= end]
    return min(later) if later else end


def apply_legend(timetable, page):
    """Subject codes (INF_MT_Ue) are explained on a "Fächer" page after the grid: put the long names into the events."""
    legend = {}
    for line in page.get_text("text").splitlines():
        m = re.match(r"^(\S{2,30})\s{2,}(\S.{3,})$", line.strip()) or re.match(r"^([A-Za-z0-9_.-]{2,30})\s+(\S.{8,})$", line.strip())
        if m:
            legend[m.group(1)] = m.group(2).strip()
    if not legend:
        return False
    for e in timetable["events"]:
        code = e["lines"][0] if e["lines"] else ""
        if code in legend:
            e["lines"] = [f"{legend[code]} ({code})"] + e["lines"][1:]
            e["text"] = " · ".join(e["lines"])
    return True


def grid_page(page):
    """One class timetable from a page, or None when the page has no weekday grid."""
    lines = lines_of(page)
    if not lines:
        return None
    matrix = page.rotation_matrix

    # Weekday headings: a row of "Mo Di Mi ..." (or Mon Tue ...) lines at about the same height.
    heads = []
    for rect, text in lines:
        for names in (DAYS_DE, DAYS_EN):
            if text in names:
                heads.append((names.index(text), rect))
    by_row = {}
    for idx, rect in heads:
        by_row.setdefault(round(rect.y0 / 6), []).append((idx, rect))
    row = max(by_row.values(), key=len, default=[])
    if len(row) < 4:
        return None
    day_x = {idx: (rect.x0 + rect.x1) / 2 for idx, rect in row}

    # Period labels: "1\n8:15\n9:45" lines stacked at the left or right edge.
    periods = []
    # Some exports print "8:00-9:30" on one line, others print the start and the end on two lines.
    for rect, text in sorted(lines, key=lambda x: x[0].y0):
        m = re.fullmatch(r"(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})", text)
        if m:
            periods.append({"start": clock(m.group(1)), "end": clock(m.group(2)), "y0": rect.y0, "y1": rect.y1, "ranged": True})
    if len(periods) < 3:
        periods = []
        label_lines = sorted([(r, t) for r, t in lines if clock(t)], key=lambda x: (x[0].y0, x[0].x0))
        by_label = {}
        for rect, text in label_lines:
            by_label.setdefault(round(rect.x0 / 20), []).append((rect, clock(text)))
        column = max(by_label.values(), key=len, default=[])
        column.sort(key=lambda x: x[0].y0)
        for i in range(0, len(column) - 1, 2):
            (a_rect, a), (b_rect, b) = column[i], column[i + 1]
            periods.append({"start": a, "end": b, "y0": a_rect.y0, "y1": b_rect.y1})
    if len(periods) < 3:
        return None

    # The timetable's own name: the longest short line in the page margin, usually "DTM, BA, Sem. 3, Start WS, Vollzeit".
    label = ""
    for rect, text in lines:
        if rect.width > 120 and len(text) > len(label) and len(text) < 90 and "," in text and not re.search(r"Untis|Seite|Rechenzentrum|Amberg, Kaiser|ltig ab|Stand", text):
            if rect.y0 < page.rect.height * 0.6 or rect.x0 < 120:
                label = text
    stand = ""
    for rect, text in lines:
        m = re.search(r"Stand:?\s*([0-9.]+)", text)
        if m:
            stand = m.group(1)
    valid = ""
    for rect, text in lines:
        m = re.search(r"ltig ab:?\s*([0-9.]+)", text)
        if m:
            valid = m.group(1)

    # Boxes: filled rectangles as wide as a day column and as tall as one or more periods.
    spacing = sorted(day_x.values())
    col_w = (spacing[-1] - spacing[0]) / max(1, len(spacing) - 1)
    ptop = min(p["y0"] for p in periods)
    pbottom = max(p["y1"] for p in periods)
    boxes = []
    seen = set()
    for d in page.get_drawings():
        fill = d.get("fill")
        if not fill or fill == (1.0, 1.0, 1.0):
            continue
        r = pymupdf.Rect(d["rect"]) * matrix
        r.normalize()
        key = (round(r.x0), round(r.y0), round(r.x1), round(r.y1))
        if key in seen or r.height < 20 or r.width < col_w * 0.12:
            continue
        seen.add(key)
        cx = (r.x0 + r.x1) / 2
        day = min(day_x, key=lambda i: abs(day_x[i] - cx))
        if abs(day_x[day] - cx) > col_w * 0.62 or r.y1 < ptop - 5 or r.y0 > pbottom + 5 or cx < spacing[0] - col_w / 2:
            continue
        boxes.append((r, fill, day))

    events = []
    for r, fill, day in boxes:
        inside = [(rect, text) for rect, text in lines
                  if r.x0 - 1 <= (rect.x0 + rect.x1) / 2 <= r.x1 + 1 and r.y0 - 1 <= (rect.y0 + rect.y1) / 2 <= r.y1 + 1
                  and not (re.fullmatch(r"\d{1,2}", text) and rect.x0 < day_x[min(day_x)] - col_w / 2)]
        if not inside:
            continue
        inside.sort(key=lambda x: (round(x[0].y0), x[0].x0))
        texts = [t for _, t in inside]
        # Which periods does the box cover? Match the box's vertical extent against the period rows.
        covered = [p for p in periods if min(r.y1, p["y1"]) - max(r.y0, p["y0"]) > (p["y1"] - p["y0"]) * 0.35]
        if not covered:
            continue
        # A day column may hold side-by-side groups; a box narrower than the column is one of them.
        joined = " | ".join(texts)
        fmt = "online" if re.search(r"\bonline\b", joined, re.I) else "hybrid" if re.search(r"hybrid", joined, re.I) else "in person"
        events.append({
            "day": day,
            "start": covered[0]["start"],
            "end": covered[-1]["end"],
            "lines": texts,
            "text": " · ".join(texts),
            "format": fmt,
        })
    if not events:
        events = text_cells(lines, day_x, col_w, periods)
    if not events:
        return None
    if not label:
        # Exports without a long name print a short class name under the header ("DD 1").
        for rect, text in sorted(lines, key=lambda x: x[0].y0):
            if rect.y0 < periods[0]["y0"] - 30 and re.fullmatch(r"[A-Za-zÄÖÜäöü0-9_./ +-]{2,24}", text) and not re.search(r"Untis|Mo|Di|Mi|Do|Fr", text) and not re.fullmatch(r"\d+\.\d+\.\d+.*", text):
                label = text
                break
    # Identical boxes drawn twice.
    unique = {}
    for e in events:
        unique[(e["day"], e["start"], e["end"], e["text"])] = e
    events = sorted(unique.values(), key=lambda e: (e["day"], e["start"], e["text"]))
    return {"label": label, "stand": stand, "validFrom": valid, "events": events}


def parse_label(label):
    """'DTM, BA, Sem. 3, Start WS, Vollzeit' -> parts. Unknown formats keep the whole label."""
    parts = [p.strip() for p in label.split(",")]
    info = {"code": parts[0] if parts else "", "level": None, "semester": None, "start": None, "mode": None}
    for p in parts[1:]:
        if re.fullmatch(r"(BA|MA|B\.?\s?Sc\.?|M\.?\s?Sc\.?|B\.?\s?Eng\.?|M\.?\s?Eng\.?)", p, re.I):
            info["level"] = "MA" if p.upper().startswith("M") else "BA"
        m = re.search(r"Sem\.?\s*(\d+)", p)
        if m:
            info["semester"] = int(m.group(1))
        m = re.search(r"Start\s*(WS|SS)", p, re.I) or re.search(r"S\w*rt\s*(WS|SS)", p, re.I)
        if m:
            info["start"] = m.group(1).upper()
        if re.search(r"vollzeit|teilzeit|dual|berufsbegleitend", p, re.I):
            info["mode"] = p
    return info


# ---------------------------------------------------------------- finding and classifying documents

CURRENT_TERM = "WS 2026/27"
TERM_ORDER = lambda t: (int(t.split()[1][:4]), 1 if t.startswith("WS") else 0) if t else (0, 0)  # noqa: E731


def clean(text):
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", text or ""))).strip()


def collect_links():
    """Every PDF the university's pages link to: {url: {labels, pages}}. Pages are the cached crawl plus the timetable pages."""
    found = {}
    html_dir = ROOT / "storage" / "oth-crawl" / "html"

    def pages():
        # One page at a time: the cached crawl is hundreds of megabytes.
        for p in PLAN_PAGES:
            yield p, fetch(p) or ""
        for file in sorted(html_dir.glob("*.html")) if html_dir.exists() else []:
            yield None, file.read_text("utf-8", "replace")

    saved = ROOT / "storage" / "oth-crawl" / "links.json"
    if not html_dir.exists() or not any(html_dir.glob("*.html")):
        # The page cache was removed to save disk space: the link index made from it is enough.
        if saved.exists():
            return {u: {"labels": r["labels"], "pages": [tuple(p) for p in r["pages"]]} for u, r in json.loads(saved.read_text("utf-8")).items()}
        return {}

    for page_url, html in pages():
        canonical = re.search(r'<link rel="canonical" href="([^"]+)"', html)
        page = page_url or (unescape(canonical.group(1)) if canonical else "")
        h1 = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.S)
        title = clean(h1.group(1)) if h1 else ""
        # Find each PDF link first, then read the link text up to its closing tag: one pattern with a lazy group
        # over whole pages is far too slow on the 2,000 cached pages.
        for m in re.finditer(r'href="((?:https://www\.oth-aw\.de)?/files/[^"]{3,300}?\.pdf)"', html):
            url = unescape(m.group(1))
            if url.startswith("/"):
                url = HOST + url
            rec = found.setdefault(url, {"labels": [], "pages": []})
            tail = html[m.end():m.end() + 700]
            close = tail.find("</a>")
            label = clean(tail[tail.find(">") + 1:close] if close > 0 else "")
            if label and label not in rec["labels"]:
                rec["labels"].append(label[:160])
            if page and (page, title) not in rec["pages"]:
                rec["pages"].append((page, title))
    saved.write_text(json.dumps(found, ensure_ascii=False), encoding="utf-8")
    return found


def term_from_text(text):
    """'Sommersemester 2026' / 'Wintersemester 2026/27' / 'SoSe26' / 'WS2627' -> 'SoSe 2026' / 'WS 2026/27', or None."""
    t = text.replace("_", " ").replace("-", " ")
    m = re.search(r"(Sommer|Summer)\s*(?:semester|term)?\s*(20\d{2})", t, re.I) or re.search(r"\b(?:SoSe|SS)\s*(20\d{2}|\d{2})\b", t, re.I)
    if m:
        y = m.group(2) if len(m.groups()) > 1 and m.group(2) else m.group(1)
        y = y if len(y) == 4 else "20" + y
        return f"SoSe {y}"
    m = re.search(r"(Winter)\s*(?:semester|term)?\s*(20\d{2})\s*/?\s*(20)?(\d{2})", t, re.I) or re.search(r"\b(?:WiSe|WS)\s*(20)?(\d{2})\s*/?\s*(20)?(\d{2})\b", t, re.I)
    if m:
        g = [x for x in m.groups() if x]
        digits = "".join(re.findall(r"\d", " ".join(g)))
        if len(digits) >= 6:
            return f"WS {digits[:4]}/{digits[-2:]}"
        if len(digits) == 4:
            return f"WS 20{digits[:2]}/{digits[2:]}"
    return None


def classify(url, labels, pages):
    """(kind, term, year): kind is timetable | exam-plan | semester-plan | study-plan | module-handbook | regulations | map | rooms | other."""
    text = f"{url} {' '.join(labels)}"
    low = text.lower()
    name = url.rsplit("/", 1)[-1].lower()
    if re.search(r"hoersaal|hörsaal|lecture.?hall|raumbelegung|hoersaaleinteilung|hoersaalbelegung", low):
        kind = "rooms"
    elif re.search(r"pr(ue|ü)fungsplan|pr(ue|ü)funggsplan|examination.?schedule|exam.?schedule|pruefungen|examinations", low) and not re.search(r"ordnung|regulations|spo", low):
        kind = "exam-plan"
    elif re.search(r"semesterplan|semester.?plan|semestertermine|vorlesungszeit|akademischer.?kalender|calendar|terminplan|termine", name + " " + low[:200]) and not re.search(r"ordnung|regulations", low):
        kind = "semester-plan"
    elif re.search(r"stundenplan|timetable|_71-72|mki_71", low):
        kind = "timetable"
    elif re.search(r"modulhandbuch|module.?handbook|course.?catalogue|mhb", low):
        kind = "module-handbook"
    elif re.search(r"studienplan|study.?plan", low):
        kind = "study-plan"
    elif re.search(r"spo|studien.?und.?pr(ue|ü)fungsordnung|regulations|satzung|ordnung", low):
        kind = "regulations"
    elif re.search(r"lageplan|campus.?plan|standort|gelaende|map\b", low):
        kind = "map"
    else:
        kind = "other"
    term = term_from_text(text)
    years = [int(y) for y in re.findall(r"(20[12]\d)", text)]
    return kind, term, (max(years) if years else None)


def wanted(kind, term, year, on_plan_page):
    """Documents worth reading in full: timetables, exam plans, the calendar and room plans of this and last semester, recent study plans."""
    if kind in ("timetable", "exam-plan", "rooms", "semester-plan"):
        return on_plan_page or year is None or year >= 2025
    if kind == "study-plan":
        return year is not None and year >= 2026
    if kind == "map":
        return True
    return False


# ---------------------------------------------------------------- exam plans

def split_words(text):
    """The plans are typeset without spaces between some words ('AdvancedBusinessEnglish'): put them back."""
    text = re.sub(r"(?<=[a-zäöüß])(?=[A-ZÄÖÜ])", " ", text)
    text = re.sub(r"(?<=[a-zA-Zäöüß])(?=\d)|(?<=\d)(?=[A-Za-zäöüß]{3})", " ", text)
    return re.sub(r"\s+", " ", text).strip()


DATE_A = re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b")
DATE_B = re.compile(r"\b(\d{2})(\d{2})(20\d{2})\s*\.\s*\.")
TIME = re.compile(r"\b(\d{1,2}):(\d{2})\b")


def first_date(cells):
    for c in cells:
        m = DATE_A.search(c) or DATE_B.search(c)
        if m:
            d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if 1 <= d <= 31 and 1 <= mo <= 12:
                return f"{y}-{mo:02d}-{d:02d}"
    return None


def header_map(row):
    """Column roles from a header row: module, examiner, room, semester, form, aids."""
    cols = {}
    for i, c in enumerate(row):
        t = re.sub(r"[^a-zäöü]", "", (c or "").lower())
        if re.search(r"modul|pr(ü|u)fung$|^pr(ü|u)fung|nameof|bezeichnung|veranstaltung", t) and "module" not in cols and not re.search(r"form|art", t):
            cols["module"] = i
        elif re.search(r"pr(ü|u)fer|examiner", t):
            cols.setdefault("examiner", i)
        elif re.search(r"raum|room|hs|einteilung", t):
            cols.setdefault("room", i)
        elif re.search(r"datum|date", t):
            cols.setdefault("date", i)
    return cols


def exam_rows(doc, url, label, code, faculty, known_codes):
    rows = []
    cols = {}
    width = 0
    for page in doc:
        try:
            tables = page.find_tables().tables
        except Exception:  # noqa: BLE001
            tables = []
        for table in tables:
            data = table.extract()
            for r, row in enumerate(data):
                cells = [split_words(re.sub(r"[\x00-\x1f�]+", " ", c or "")) for c in row]
                if not any(cells):
                    continue
                joined_low = " ".join(cells).lower()
                if re.search(r"\b(datum|date)\b", joined_low) and re.search(r"modul|pr(ü|u)fung|exam|module", joined_low) and not first_date(cells):
                    filled = [c for c in cells if c]
                    # Some plans print the whole header in the first cell ("STG Datum Dauer Beginn Modul"): read it by word.
                    cols = header_map(filled[0].split() if len(filled) == 1 else cells)
                    width = len(cells)
                    continue
                date_iso = first_date(cells)
                no_dates = DATE_B.sub(" ", DATE_A.sub(" ", " ".join(cells)))
                times = [f"{int(a):02d}:{b}" for a, b in TIME.findall(no_dates)]
                module = ""
                if cols.get("module") is not None and len(cells) == width and cells[cols["module"]]:
                    module = cells[cols["module"]]
                else:
                    candidates = [c for c in cells if len(re.findall(r"[A-Za-zÄÖÜäöüß]", c)) >= 6 and not DATE_A.search(c) and not re.fullmatch(r"[A-Z]{2,5}", c)]
                    module = max(candidates, key=len) if candidates else ""
                if not module and not date_iso:
                    continue
                prog = next((c for c in cells if c in known_codes), None) or code
                parts = [c for c in cells if c]
                rows.append({
                    "programme": prog,
                    "faculty": faculty,
                    "date": date_iso,
                    "start": times[0] if times else None,
                    "end": times[1] if len(times) > 1 else None,
                    "module": module[:140],
                    "text": " · ".join(parts)[:400],
                })
    return rows


def term_of_doc(doc, url, labels, rows):
    head = " ".join(doc[i].get_text("text")[:1500] for i in range(min(2, len(doc))))
    term = term_from_text(head) or term_from_text(url + " " + " ".join(labels))
    if term:
        return term
    months = [int(r["date"][5:7]) for r in rows if r["date"]]
    years = [int(r["date"][:4]) for r in rows if r["date"]]
    if months:
        m = max(set(months), key=months.count)
        y = max(set(years), key=years.count)
        if m in (6, 7, 8, 9):
            return f"SoSe {y}"
        if m in (1, 2, 3):
            return f"WS {y - 1}/{str(y)[2:]}"
        if m in (10, 11, 12):
            return f"WS {y}/{str(y + 1)[2:]}"
    return None


# ---------------------------------------------------------------- main

def chunk_text(text, size=6000):
    chunks, current = [], ""
    for block in re.split(r"\n\n", text):
        if len(current) + len(block) > size and current:
            chunks.append(current)
            current = ""
        current += block + "\n\n"
    if current.strip():
        chunks.append(current)
    return chunks


def record(id_, category, title, content, url, tags, volatility="term-specific"):
    return {
        "id": id_, "institution": "OTH Amberg-Weiden", "category": category, "title": title[:118], "content": content[:6900],
        "sources": [{"id": "pdf", "url": url}], "tags": tags, "observed_on": TODAY, "volatility": volatility, "access": "public", "notes": "",
    }


def main():
    out = ROOT / "resources"
    links = collect_links()
    plan_urls = {u for u, _ in plan_links()}
    print(len(links), "PDFs are linked from the university's pages;", len(plan_urls), "from the timetable pages")

    classes, exams, sources, documents, exam_docs = [], [], [], [], []
    known = set()
    for url in links:
        code, _ = programme_from_url(url)
        if code:
            known.add(code)

    for url, info in sorted(links.items()):
        labels = info["labels"]
        kind, term_hint, year = classify(url, labels, info["pages"])
        if not wanted(kind, term_hint, year, url in plan_urls):
            continue
        label = labels[0] if labels else url.rsplit("/", 1)[-1]
        path = cached_pdf(url)
        if not path:
            continue
        code, level = programme_from_url(url)
        faculty = (re.search(r"/Fakultaeten/([A-Za-z]+)/", url) or [None, None])[1]
        try:
            doc = pymupdf.open(path)
        except Exception as error:  # noqa: BLE001
            print("  cannot open", url, error, file=sys.stderr)
            continue
        first = doc[0].get_text("text")[:1200] if len(doc) else ""
        is_catalogue = bool(re.search(r"Course Catalogue|Modulhandbuch", first))

        found = 0
        latest = None
        if kind == "timetable":
            for page in doc:
                grid = grid_page(page)
                if not grid:
                    if latest and re.search(r"\bF.{1,2}cher\b", page.get_text("text")[:600]):
                        apply_legend(latest, page)
                    continue
                info_l = parse_label(grid["label"])
                header = page.get_text("text")[:2500]
                classes.append(latest := {
                    "programme": code or info_l["code"], "programmeName": re.sub(r"^(Stundenplan|Studienplan|Prüfungsplan|Timetable)\s+", "", label.split(" / ")[0]).strip(),
                    "level": info_l["level"] or (("BA" if level == "Bachelor" else "MA") if level else None), "semester": info_l["semester"], "start": info_l["start"],
                    "mode": info_l["mode"], "label": grid["label"], "stand": grid["stand"], "validFrom": grid["validFrom"], "term": term_from_text(header) or term_hint,
                    "source": url, "events": grid["events"],
                })
                found += 1
            # A file linked as a timetable that holds no grid but is a course catalogue (International Business).
            if found == 0 and is_catalogue:
                kind = "module-handbook"

        count = 0
        term = term_hint
        if kind == "exam-plan":
            rows = exam_rows(doc, url, label, code, faculty, known)
            term = term_of_doc(doc, url, labels, rows) or term_hint
            for r in rows:
                r.update({"term": term, "source": url, "label": label})
            exams.extend(rows)
            count = len(rows)
            for i, r in enumerate(rows):
                when = r["date"] or "no fixed date (coursework or to be announced)"
                who = r["programme"] or (f"faculty {r['faculty']}" if r["faculty"] else "")
                exam_docs.append(record(
                    "OTH-EXAM-" + hashlib.sha1(f"{url}{i}".encode()).hexdigest()[:12], "Exam schedule",
                    f"Exam: {r['module'] or label} ({term or 'term unknown'})",
                    f"Exam {term or ''}{(' · ' + who) if who else ''}\n{when}{(' ' + r['start']) if r['start'] else ''}{('–' + r['end']) if r['end'] else ''}\n{r['text']}\nSource: {label}",
                    url, ["exam", "Prüfung", term or "", r["programme"] or ""]))
        sources.append({"title": label, "url": url, "kind": kind, "term": term, "year": year, "programme": code, "faculty": faculty, "pages": len(doc), "timetables": found, "exams": count})
        print(f"  {kind:13} {label[:62]:62} {len(doc):3}p  grids {found:2}  exams {count:3}  {term or ''}")

        if kind in ("exam-plan", "semester-plan", "rooms", "study-plan", "map", "timetable") or kind == "module-handbook":
            if kind == "module-handbook":
                continue
            text = "\n".join(p.get_text("text", sort=True) for p in doc).strip()
            text = re.sub(r"\n{3,}", "\n\n", text)
            if len(text) > 120:
                chunks = chunk_text(text)
                category = {"exam-plan": "Exam plans", "semester-plan": "Semester calendar", "rooms": "Lecture hall allocation", "study-plan": "Study plans", "map": "Maps", "timetable": "Timetables"}[kind]
                for i, chunk in enumerate(chunks[:8]):
                    documents.append(record(
                        "OTH-PLAN-" + hashlib.sha1((url + str(i)).encode()).hexdigest()[:12], category,
                        label + (f" ({i + 1}/{len(chunks)})" if len(chunks) > 1 else ""),
                        f"{label}\n{('Term: ' + term) if term else ''}\nOfficial document, published by OTH Amberg-Weiden.\n\n{chunk.strip()}", url,
                        [kind, code or "", term or "", "de" if re.search(r"[äöüß]|Pr[üu]fung|Stunden", label) else "en"]))

    # Current timetables only: older semesters are listed in the index but not used for "what do I have".
    classes = [c for c in classes if not c.get("term") or TERM_ORDER(c["term"]) >= TERM_ORDER(CURRENT_TERM)]

    # Every other document is indexed by the page that links it: a title, the year, and the link, so the assistant can point to it.
    index = {}
    for url, info in links.items():
        kind, term, year = classify(url, info["labels"], info["pages"])
        for page, title in (info["pages"] or [("", "University documents")])[:1]:
            index.setdefault((page, title), []).append((year or 0, kind, term, info["labels"][0] if info["labels"] else url.rsplit("/", 1)[-1], url))
    index_docs = []
    for (page, title), docs in sorted(index.items()):
        docs.sort(key=lambda d: (-d[0], d[3]))
        for part in range(0, len(docs), 25):
            lines = [f"- {label} ({kind.replace('-', ' ')}{', ' + term if term else (', ' + str(year) if year else '')}): {url}" for year, kind, term, label, url in docs[part:part + 25]]
            index_docs.append(record(
                "OTH-DOCS-" + hashlib.sha1(f"{page}{part}".encode()).hexdigest()[:12], "Document index",
                f"Documents on the page: {title or page}" + (f" ({part // 25 + 1})" if len(docs) > 25 else ""),
                f"Documents linked from \"{title or page}\" ({page}). Newest first. Give the user the document title as a link.\n" + "\n".join(lines), page or HOST,
                ["documents", "PDF", "download", "Dokumente"], "stable"))

    (out / "oth-timetables.json").write_text(json.dumps({"generatedOn": TODAY, "currentTerm": CURRENT_TERM, "sources": sources, "classes": classes}, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "oth-exams.json").write_text(json.dumps({"generatedOn": TODAY, "exams": exams}, ensure_ascii=False), encoding="utf-8")
    for name, items in (("OTH_Timetable_Documents.jsonl", documents), ("OTH_Exams.jsonl", exam_docs), ("OTH_Document_Index.jsonl", index_docs)):
        (out / name).write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in items), encoding="utf-8")
    print(f"{len(classes)} class timetables ({sum(len(c['events']) for c in classes)} events), {len(exams)} exam rows, {len(documents)} document records, {len(index_docs)} index records for {len(links)} PDFs")


if __name__ == "__main__":
    main()
