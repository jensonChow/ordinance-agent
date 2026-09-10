#!/usr/bin/env python3
"""Build data/basic-law.en.json from the official Basic Law booklet PDF.

Source: https://www.basiclaw.gov.hk/filemanager/content/en/files/basiclawtext/basiclaw_full_text.pdf
The booklet states the text "has no legal status, and is made available for information only".
This corpus is for demonstration and study purposes only.

Usage:
  python3 scripts/parse_basic_law.py [--pdf path] [--txt path] [--out data/basic-law.en.json]
Requires `pdftotext` (poppler) on PATH unless --txt is given.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

PDF_URL = "https://www.basiclaw.gov.hk/filemanager/content/en/files/basiclawtext/basiclaw_full_text.pdf"

RE_PAGE = re.compile(r"^\s*\d{1,3}\s*$")
RE_PREAMBLE = re.compile(r"^\s*Preamble\s*$")
RE_CHAPTER = re.compile(r"^\s*Chapter\s+([IVX]+)\s+(.+?)\s*$")
RE_SECTION = re.compile(r"^\s*Section\s+(\d+)\s+(.+?)\s*$")
RE_ARTICLE = re.compile(r"^\s*Article\s+(\d+)\s*$")
RE_ANNEX = re.compile(r"^\s*Annex\s+(I{1,3}|IV):?\s+(.+?)\s*$")
RE_INSTRUMENT = re.compile(r"^\s*Instrument\s+\d+\b")


def load_text(pdf: Path, txt: Path | None) -> list[str]:
    if txt and txt.exists():
        return txt.read_text(encoding="utf-8").splitlines()
    if not pdf.exists():
        pdf.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {PDF_URL}", file=sys.stderr)
        urllib.request.urlretrieve(PDF_URL, pdf)
    out = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], check=True, capture_output=True, text=True)
    return out.stdout.splitlines()


def find_basic_law_span(lines: list[str]) -> tuple[int, int]:
    """The booklet also contains the PRC Constitution; the Basic Law starts at the second 'Preamble'
    that is followed by 'Chapter I General Principles', and ends before the first 'Instrument N' heading
    that comes after Annex III."""
    preambles = [i for i, l in enumerate(lines) if RE_PREAMBLE.match(l)]
    start = None
    for i in preambles:
        window = "\n".join(lines[i : i + 60])
        if "Chapter I General Principles" in window and "Hong Kong Special Administrative Region" in window:
            start = i
            break
    if start is None:
        raise SystemExit("could not locate Basic Law preamble")
    annex3 = next(i for i, l in enumerate(lines) if i > start and re.match(r"^\s*Annex III:?\s+National Laws", l))
    end = next(i for i, l in enumerate(lines) if i > annex3 and RE_INSTRUMENT.match(l))
    return start, end


def join_heading(lines: list[str], i: int, title: str) -> tuple[str, int]:
    """Headings may wrap onto the next line (e.g. 'Chapter II Relationship between ... the Hong' / 'Kong ...')."""
    j = i + 1
    while j < len(lines) and lines[j].strip() == "":
        j += 1
    nxt = lines[j].strip() if j < len(lines) else ""
    if (
        nxt
        and not RE_ARTICLE.match(nxt)
        and not RE_PAGE.match(nxt)
        and not RE_SECTION.match(nxt)
        and not RE_CHAPTER.match(nxt)
        and not RE_ANNEX.match(nxt)
        and (title.endswith(("and", "the", "of", "Hong", "to")) or nxt[0].isupper() and len(nxt.split()) <= 6)
    ):
        return f"{title} {nxt}", j
    return title, i


RE_NOTE = re.compile(r"^\s*Notes?:\s*$")


def paragraphs(block: list[str]) -> tuple[str, list[str]]:
    """Rebuild paragraphs from `pdftotext -layout` output.

    Layout rules observed in the booklet: a paragraph or list item starts with a small indent
    (1-6 spaces); continuation lines of a list item are indented deeper (7+ spaces); continuation
    lines of a normal paragraph start at column 0. Page numbers are lone integers. Footnotes start
    with a 'Note:' line and run until the next blank line; they are returned separately.
    """
    paras: list[str] = []
    notes: list[str] = []
    cur: list[str] = []
    note_cur: list[str] = []
    in_note = False

    def flush_par() -> None:
        nonlocal cur
        if cur:
            paras.append(" ".join(cur))
            cur = []

    for raw in block:
        if RE_PAGE.match(raw):
            continue
        line = raw.rstrip()
        stripped = line.strip()
        if in_note:
            if not stripped:
                in_note = False
                if note_cur:
                    notes.append(re.sub(r"\s+", " ", " ".join(note_cur)))
                    note_cur = []
                continue
            note_cur.append(stripped)
            continue
        if RE_NOTE.match(line):
            flush_par()
            in_note = True
            continue
        if not stripped:
            continue
        indent = len(line) - len(line.lstrip(" "))
        if 1 <= indent <= 6 and cur:
            flush_par()
        cur.append(re.sub(r"\s+", " ", stripped))
    flush_par()
    if note_cur:
        notes.append(re.sub(r"\s+", " ", " ".join(note_cur)))
    return "\n\n".join(paras), notes


def parse(lines: list[str]) -> dict:
    start, end = find_basic_law_span(lines)
    seg = lines[start:end]
    chapters: list[dict] = []
    articles: list[dict] = []
    annexes: list[dict] = []
    preamble_buf: list[str] = []

    chapter: dict | None = None
    section: dict | None = None
    current: dict | None = None  # article or annex being filled
    buf: list[str] = []
    mode = "preamble"

    def flush() -> None:
        nonlocal buf, current
        if current is not None:
            text, notes = paragraphs(buf)
            current["text"] = text
            if notes:
                current["notes"] = notes
        buf = []

    i = 0
    while i < len(seg):
        line = seg[i]
        m_ch = RE_CHAPTER.match(line)
        m_sec = RE_SECTION.match(line)
        m_art = RE_ARTICLE.match(line)
        m_anx = RE_ANNEX.match(line)
        if mode != "annex" and m_ch and not line.strip().endswith("."):
            flush(); current = None
            title, i = join_heading(seg, i, m_ch.group(2))
            chapter = {"number": m_ch.group(1), "title": title, "sections": []}
            chapters.append(chapter)
            section = None
            mode = "body"
        elif mode == "body" and m_sec and chapter is not None:
            flush(); current = None
            title, i = join_heading(seg, i, re.sub(r"\s+", " ", m_sec.group(2)))
            section = {"number": int(m_sec.group(1)), "title": title}
            chapter["sections"].append(section)
        elif mode != "annex" and m_art:
            flush()
            current = {
                "article": int(m_art.group(1)),
                "chapter": chapter["number"] if chapter else None,
                "chapterTitle": chapter["title"] if chapter else None,
                "section": section["number"] if section else None,
                "sectionTitle": section["title"] if section else None,
                "text": "",
            }
            articles.append(current)
            mode = "body"
        elif m_anx and (mode == "body" and current is not None and current.get("article") == 160 or mode == "annex"):
            flush()
            title, i = join_heading(seg, i, re.sub(r"\s+", " ", m_anx.group(2)))
            current = {"annex": m_anx.group(1), "title": title, "text": ""}
            annexes.append(current)
            mode = "annex"
        elif mode == "preamble":
            if not RE_PREAMBLE.match(line):
                preamble_buf.append(line)
        else:
            buf.append(line)
        i += 1
    flush()

    return {
        "source": {
            "title": "The Basic Law of the Hong Kong Special Administrative Region of the People's Republic of China",
            "pdf": PDF_URL,
            "notice": "Booklet text has no legal status and is made available for information only; demo corpus for study purposes.",
        },
        "preamble": paragraphs(preamble_buf)[0],
        "chapters": chapters,
        "articles": articles,
        "annexes": annexes,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default="data/source/basiclaw_full_text.pdf")
    ap.add_argument("--txt", default=None)
    ap.add_argument("--out", default="data/basic-law.en.json")
    args = ap.parse_args()
    lines = load_text(Path(args.pdf), Path(args.txt) if args.txt else None)
    data = parse(lines)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    nums = [a["article"] for a in data["articles"]]
    missing = sorted(set(range(1, 161)) - set(nums))
    dups = sorted({n for n in nums if nums.count(n) > 1})
    print(f"articles={len(nums)} chapters={len(data['chapters'])} annexes={len(data['annexes'])} missing={missing} dups={dups}")
    empties = [a["article"] for a in data["articles"] if len(a["text"]) < 20]
    print(f"short/empty articles: {empties}")


if __name__ == "__main__":
    main()
