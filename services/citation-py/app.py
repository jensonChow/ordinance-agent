"""Tiny citation-formatting service (Flask), served by Gunicorn in production.

The Next.js agent calls POST /cite when CITATION_SERVICE_URL is set; otherwise it formats locally.
Run (dev):  .venv/bin/flask --app app run --port 8000
Run (prod): .venv/bin/gunicorn -w 2 -b 0.0.0.0:8000 app:app
"""
from flask import Flask, jsonify, request

app = Flask(__name__)

STYLES = {
    "short": lambda a, p: f"Basic Law, art. {a}" + (f"({p})" if p else ""),
    "long": lambda a, p: (
        f"Article {a}" + (f", paragraph {p}" if p else "")
        + " of the Basic Law of the Hong Kong Special Administrative Region of the People's Republic of China"
    ),
}


@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


@app.post("/cite")
def cite():
    data = request.get_json(force=True, silent=True) or {}
    try:
        article = int(data["article"])
    except (KeyError, TypeError, ValueError):
        return jsonify(error="article (1-160) is required"), 400
    if not 1 <= article <= 160:
        return jsonify(error="article must be between 1 and 160"), 400
    paragraph = data.get("paragraph")
    paragraph = int(paragraph) if paragraph not in (None, "") else None
    style = data.get("style", "short")
    if style not in STYLES:
        return jsonify(error=f"unknown style {style!r}"), 400
    return jsonify(citation=STYLES[style](article, paragraph), style=style)
