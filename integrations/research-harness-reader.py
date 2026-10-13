"""Nexus read-only additions for Research Harness 0.16 workbench records.

Run with the Harness environment's Python and an explicit project path. No
WorkbenchService is started: its history recovery and provider vault are not
part of a read operation. Nexus separately allowlists and approves every tool.
"""
from __future__ import annotations

import argparse
import re
from contextlib import contextmanager

from research_harness.agent_server import create_agent_server
from research_harness.models import HarnessError, canonical, digest, identifier
from research_harness.store import Store
from research_harness.workbench.documents import document_info


KINDS = {"workbench_answer", "causal_worksheet", "prompt_experiment"}
SCOPE = ("Saved working context, not approved scientific evidence. Exact quotes do not "
         "establish claim support. Causal worksheets do not establish causation; prompt "
         "scores measure supplied phrase checks, not scientific accuracy. Running "
         "experiments are reported as saved; this reader cannot determine worker liveness.")


def integer(value, name, low, high):
    if type(value) is not int or not low <= value <= high:
        raise HarnessError(f"{name} must be an integer in {low}..{high}")


def kind_name(kind):
    if not isinstance(kind, str) or kind not in KINDS:
        raise HarnessError("Choose workbench_answer, causal_worksheet or prompt_experiment")


@contextmanager
def read_store(project):
    store = Store(project)
    try:
        store.db.execute("PRAGMA query_only=ON")
        store.db.execute("BEGIN")
        yield store
    finally:
        store.db.rollback()
        store.close()


def context_status(store, kind, record):
    """Read dependencies in the same SQLite snapshot; do not repair saved state."""
    dependencies, stale = {}, False
    if kind == "prompt_experiment":
        pins = [(record.get("prompt_id"), record.get("prompt_version"))]
        activated = record.get("activated_prompt")
        if record.get("status") == "activated" and not isinstance(activated, dict):
            return {"stale": True, "dependencies": {}, "basis": "missing activated prompt reference"}
        if record.get("status") == "activated":
            pins.append((activated.get("id"), activated.get("version")))
        elif record.get("candidate_id"):
            pins.append((record["candidate_id"], record.get("candidate_version")))
        for key, expected in pins:
            if not isinstance(key, str) or type(expected) is not int or expected < 1:
                return {"stale": True, "dependencies": {}, "basis": "invalid saved prompt references"}
            try:
                current = store.get("role_prompt", key)
                dependencies[str(key)] = {"version": current["version"]}
                stale |= type(expected) is not int or current["version"] != expected
            except HarnessError:
                dependencies[str(key)] = {"missing": True}
                stale = True
        return {"stale": bool(stale), "dependencies": dependencies,
                "basis": "saved prompt versions; no activation or liveness check"}

    snapshot = record.get("source_snapshot")
    if not isinstance(snapshot, dict):
        return {"stale": True, "dependencies": {}, "basis": "missing source snapshot"}
    if kind == "workbench_answer":
        sources, statements = record.get("source_ids"), record.get("statements")
        if (not isinstance(sources, list) or not sources or any(not isinstance(s, str) for s in sources)
                or set(sources) != set(snapshot) or not isinstance(statements, list)
                or any(not isinstance(s, dict) or not isinstance(s.get("citations"), list)
                       or not s["citations"] for s in statements)
                or (record.get("status") == "answered" and not statements)):
            return {"stale": True, "dependencies": {}, "basis": "invalid saved answer references"}
        citations = [citation for statement in statements for citation in statement["citations"]]
    else:
        citations = record.get("citations")
    if not isinstance(citations, list) or any(not isinstance(c, dict) for c in citations):
        return {"stale": True, "dependencies": {}, "basis": "invalid saved citations"}
    for key, expected in snapshot.items():
        try:
            source = store.get("source", key)
            current = {name: source[name] for name in ("version", "text_hash", "raw_hash")}
            if (type(current["version"]) is not int
                    or any(not isinstance(current[name], str) or not re.fullmatch(r"[a-f0-9]{64}", current[name])
                           for name in ("text_hash", "raw_hash"))):
                raise HarnessError("Invalid source identity")
            dependencies[key] = current
            store.read_blob(source["text_hash"])
            store.read_blob(source["raw_hash"])
            stale |= current != expected
        except (HarnessError, KeyError, TypeError, UnicodeError):
            dependencies[key] = {"missing_or_corrupt": True}
            stale = True
    for citation in citations:
        try:
            if (not isinstance(citation.get("source_id"), str) or citation["source_id"] not in snapshot
                    or type(citation.get("source_version")) is not int
                    or not isinstance(citation.get("text_hash"), str)):
                raise HarnessError("Citation missing from saved snapshot")
            document_info(store, citation["source_id"], citation.get("source_version"), citation)
        except (HarnessError, KeyError, TypeError, UnicodeError):
            stale = True
    return {"stale": bool(stale), "dependencies": dependencies,
            "basis": "source versions, blob integrity and exact citation spans; not scientific support"}


def payload(store, kind, record):
    value = {"kind": kind, "record": record, "context": context_status(store, kind, record), "scope": SCOPE}
    text = canonical(value)
    return value, text, digest(text.encode())


def list_artifacts(project, kind, offset=0, limit=10):
    kind_name(kind)
    integer(offset, "offset", 0, 1_000_000)
    integer(limit, "limit", 1, 20)
    with read_store(project) as store:
        keys = store.db.execute("SELECT id FROM records WHERE kind=? ORDER BY id LIMIT ? OFFSET ?",
                                (kind, limit + 1, offset)).fetchall()
        items = []
        for row in keys[:limit]:
            record = store.get(kind, row[0])
            value, text, content_hash = payload(store, kind, record)
            title = record.get("question") or record.get("title") or record.get("prompt_id") or record["id"]
            items.append({"id": record["id"], "version": record["version"], "title": str(title)[:240],
                          "status": str(record.get("status", "saved"))[:80], "stale": value["context"]["stale"],
                          "total_characters": len(text), "load": {"kind": kind, "record_id": record["id"],
                          "expected_version": record["version"], "expected_content_hash": content_hash}})
        return {"kind": kind, "items": items, "next_offset": offset + limit if len(keys) > limit else None,
                "scope": SCOPE, "pagination": "Live ID ordering; refresh discovery if records are added or removed."}


def read_artifact(project, kind, record_id, expected_version, expected_content_hash, start=0, length=8000):
    kind_name(kind)
    identifier(record_id)
    integer(expected_version, "expected_version", 1, 2**53 - 1)
    integer(start, "start", 0, 100_000_000)
    integer(length, "length", 1, 16000)
    if not isinstance(expected_content_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_content_hash):
        raise HarnessError("expected_content_hash must be a SHA-256 hex digest from discovery")
    with read_store(project) as store:
        record = store.get(kind, record_id)
        value, text, content_hash = payload(store, kind, record)
        if record["version"] != expected_version or content_hash != expected_content_hash:
            raise HarnessError("Record or its source/prompt context changed; refresh discovery before reading more")
        if start > len(text):
            raise HarnessError("start exceeds the saved output length")
        end = min(start + length, len(text))
        return {"kind": kind, "record_id": record_id, "version": record["version"], "content_hash": content_hash,
                "stale": value["context"]["stale"], "total_characters": len(text), "start": start, "end": end,
                "text": text[start:end], "next_start": end if end < len(text) else None,
                "complete": start == 0 and end == len(text), "scope": SCOPE}


def create_reader(project):
    server = create_agent_server(project, "critic")

    @server.tool()
    def list_workbench_artifacts(kind: str, offset: int = 0, limit: int = 10) -> dict:
        """Discover bounded saved Q&A, causal worksheets or prompt experiments; returns version/hash-pinned load arguments."""
        return list_artifacts(project, kind, offset, limit)

    @server.tool()
    def read_workbench_artifact(kind: str, record_id: str, expected_version: int,
                                expected_content_hash: str, start: int = 0, length: int = 8000) -> dict:
        """Read saved JSON pages using discovery pins. Reject changes to records or source/prompt context; stale outputs are historical only."""
        return read_artifact(project, kind, record_id, expected_version, expected_content_hash, start, length)

    @server.tool()
    def inspect_source_document(source_id: str, expected_version: int, citation: dict | None = None) -> dict:
        """Read original-document metadata and optionally check an exact citation. No PDF bytes, external paths or guessed PDF page numbers."""
        integer(expected_version, "expected_version", 1, 2**53 - 1)
        with read_store(project) as store:
            return document_info(store, source_id, expected_version, citation)

    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    create_reader(parser.parse_args().project).run(transport="stdio")
