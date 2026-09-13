"""Citation service for the Basic Law Study Agent (Flask), served by Gunicorn.

It stands in for the kind of existing Python application a new agent app has to keep working with: the Next.js
agent calls it when CITATION_SERVICE_URL is set and falls back to its own implementation when the service is
down, so neither side is a hard dependency of the other.

  format:  POST /cite   {"article": 24, "paragraph": 2, "style": "short"|"long"}
  parse:   POST /parse  {"text": "see BL art 24(2), Articles 39 and 41, and Articles 45 to 47"}

Run (dev):  .venv/bin/flask --app app run --port 8000
Run (prod): .venv/bin/gunicorn -w 2 -b 0.0.0.0:8000 app:app
"""
import re

from flask import Flask, jsonify, request

app = Flask(__name__)

MIN_ARTICLE, MAX_ARTICLE = 1, 160

STYLES = {
    "short": lambda a, p: f"Basic Law, art. {a}" + (f"({p})" if p else ""),
    "long": lambda a, p: (
        f"Article {a}" + (f", paragraph {p}" if p else "")
        + " of the Basic Law of the Hong Kong Special Administrative Region of the People's Republic of China"
    ),
}

# Kept in step with parseCitations() in src/lib/text.ts — same rules, same results.
LEAD_IN = re.compile(r"\b(?:articles?|arts?\.?|bl)\.?\s*(?=\d)", re.IGNORECASE)
NUMBER = re.compile(r"^(\d{1,3})(?:\s*\((\d{1,2})\))?")
SEPARATOR = re.compile(r"^\s*(?:,\s*)?(and|to|through|,|-|–|—)\s*(?=\d)", re.IGNORECASE)
RANGE = re.compile(r"^(to|through|-|–|—)$", re.IGNORECASE)


def parse_citations(text: str):
    """Pull Basic Law citations out of free text. Lexical and deliberately small; see the TypeScript twin."""
    out, seen = [], set()

    def push(article, paragraph, raw):
        if not MIN_ARTICLE <= article <= MAX_ARTICLE:
            return
        key = (article, paragraph)
        if key in seen:
            return
        seen.add(key)
        out.append({"article": article, "paragraph": paragraph, "raw": raw})

    for lead in LEAD_IN.finditer(text):
        cursor = lead.end()
        previous = None
        connector = None
        while True:
            num = NUMBER.match(text[cursor:])
            if not num:
                break
            article = int(num.group(1))
            paragraph = int(num.group(2)) if num.group(2) else None
            if previous is not None and connector and RANGE.match(connector) and article > previous:
                for n in range(previous + 1, article):
                    push(n, None, f"{previous}–{article}")
            push(article, paragraph, num.group(0).strip())
            previous = article
            cursor += num.end()
            sep = SEPARATOR.match(text[cursor:])
            if not sep:
                break
            connector = sep.group(1)
            cursor += sep.end()
    return out


@app.get("/")
def index():
    """Tiny service index — also what the browser shows when the container is up."""
    return jsonify(
        service="citation-py",
        description="Citation formatting and parsing for the Basic Law Study Agent.",
        endpoints={
            "GET /healthz": "liveness",
            "POST /cite": '{"article": 24, "paragraph": 2, "style": "short|long"}',
            "POST /parse": '{"text": "free text containing citations"}',
        },
    )


@app.get("/healthz")
def healthz():
    return jsonify(ok=True, service="citation-py")


@app.post("/cite")
def cite():
    data = request.get_json(force=True, silent=True) or {}
    try:
        article = int(data["article"])
    except (KeyError, TypeError, ValueError):
        return jsonify(error="article (1-160) is required"), 400
    if not MIN_ARTICLE <= article <= MAX_ARTICLE:
        return jsonify(error="article must be between 1 and 160"), 400
    paragraph = data.get("paragraph")
    paragraph = int(paragraph) if paragraph not in (None, "") else None
    style = data.get("style", "short")
    if style not in STYLES:
        return jsonify(error=f"unknown style {style!r}"), 400
    return jsonify(citation=STYLES[style](article, paragraph), style=style)


@app.post("/parse")
def parse():
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        return jsonify(error="text is required"), 400
    if len(text) > 20000:
        return jsonify(error="text must be at most 20000 characters"), 400
    citations = parse_citations(text)
    for c in citations:
        c["citation"] = STYLES["short"](c["article"], c["paragraph"])
    return jsonify(citations=citations, count=len(citations))
