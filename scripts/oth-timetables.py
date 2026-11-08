"""
Builds the OTH Amberg-Weiden timetable data from the university's published PDFs.

    pip install pymupdf
    python scripts/oth-timetables.py            # writes resources/oth-timetables.json
                                                #        resources/OTH_Timetable_Documents.jsonl

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


def main():
    out_json = ROOT / "resources" / "oth-timetables.json"
    out_docs = ROOT / "resources" / "OTH_Timetable_Documents.jsonl"
    links = plan_links()
    print(len(links), "PDFs linked from the timetable pages")

    classes = []
    documents = []
    sources = []
    for url, label in links:
        path = cached_pdf(url)
        if not path:
            continue
        code, level = programme_from_url(url)
        is_plan = bool(re.match(r"(Stundenplan|Studienplan|Timetable|Study Plan)", label, re.I)) or bool(re.search(r"/Stundenplan|/Studienplan", url, re.I))
        try:
            doc = pymupdf.open(path)
        except Exception as error:  # noqa: BLE001
            print("  cannot open", url, error, file=sys.stderr)
            continue
        found = 0
        latest = None
        for page in doc:
            grid = grid_page(page) if is_plan else None
            if not grid:
                if latest and re.search(r"\bF.{1,2}cher\b", page.get_text("text")[:600]):
                    apply_legend(latest, page)
                continue
            info = parse_label(grid["label"])
            classes.append(latest := {
                "programme": code or info["code"],
                "programmeName": re.sub(r"^(Stundenplan|Studienplan|Prüfungsplan)\s+", "", label.split(" / ")[0]).strip(),
                "level": info["level"] or (("BA" if level == "Bachelor" else "MA") if level else None),
                "semester": info["semester"],
                "start": info["start"],
                "mode": info["mode"],
                "label": grid["label"],
                "stand": grid["stand"],
                "validFrom": grid["validFrom"],
                "source": url,
                "events": grid["events"],
            })
            found += 1
        sources.append({"title": label, "url": url, "pages": len(doc), "timetables": found})
        print(f"  {label[:70]:70} {len(doc):3} pages, {found} class timetables")

        # Text of the document itself, for the questions a grid cannot answer (exam dates, notes, room allocation).
        text = "\n".join(page.get_text("text", sort=True) for page in doc).strip()
        text = re.sub(r"\n{3,}", "\n\n", text)
        if len(text) > 120:
            chunks = []
            current = ""
            for block in re.split(r"\n\n", text):
                if len(current) + len(block) > 6000 and current:
                    chunks.append(current)
                    current = ""
                current += block + "\n\n"
            if current.strip():
                chunks.append(current)
            for i, chunk in enumerate(chunks):
                documents.append({
                    "id": "OTH-PLAN-" + hashlib.sha1((url + str(i)).encode()).hexdigest()[:12],
                    "institution": "OTH Amberg-Weiden",
                    "category": "Timetables and exam plans",
                    "title": (label + (f" ({i + 1}/{len(chunks)})" if len(chunks) > 1 else ""))[:118],
                    "content": f"{label}\nOfficial document, published by OTH Amberg-Weiden.\n\n{chunk.strip()}"[:6900],
                    "sources": [{"id": "pdf", "url": url}],
                    "tags": ["timetable", "exam plan", code or "", "de" if re.search(r"[äöüß]|Pr[üu]fung|Stunden", label) else "en"],
                    "observed_on": TODAY,
                    "volatility": "term-specific",
                    "access": "public",
                    "notes": "",
                })

    out_json.write_text(json.dumps({"generatedOn": TODAY, "sources": sources, "classes": classes}, ensure_ascii=False, indent=1), encoding="utf-8")
    out_docs.write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in documents), encoding="utf-8")
    print(f"{len(classes)} class timetables, {sum(len(c['events']) for c in classes)} events, {len(documents)} document records")


if __name__ == "__main__":
    main()
