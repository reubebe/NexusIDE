"""Synthetic Cortex API contract fixture; no real knowledge or upstream engine."""
import re
from types import SimpleNamespace


def parse_list(value):
    return [item.strip() for item in value.strip("[]").split(",") if item.strip()]


def parse_page(path, brain):
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        return None
    front, body = text[4:].split("\n---\n", 1)
    meta = dict(line.split(": ", 1) for line in front.splitlines() if ": " in line)
    return SimpleNamespace(rel=path.relative_to(brain).as_posix(), title=meta.get("title", path.stem),
                           status=meta.get("status", ""), type=meta.get("type", ""), front=meta, body=body)


def score_pages(pages, query):
    return [(1, page) for page in pages if query.lower() in (page.title + page.body).lower()]


def redact_secrets(text):
    value = re.sub(r"sk-proj-[A-Za-z0-9_-]{16,}", "[REDACTED]", text)
    return value, value != text
