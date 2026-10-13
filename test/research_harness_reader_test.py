"""Local-only bridge regressions; run with the Research Harness Python environment.

No provider, WorkbenchService, real project, or network is used.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from mcp.server.fastmcp.exceptions import ToolError
from research_harness.models import HarnessError, ProjectPolicy
from research_harness.store import Store


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "integrations" / "research-harness-reader.py"
SPEC = importlib.util.spec_from_file_location("nexus_research_reader", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class ResearchHarnessReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nexus-reader-test-")
        self.project = Path(self.temp.name) / "paper"
        self.store = Store.create(self.project, ProjectPolicy(name="Synthetic reader fixture"))
        self.text = "Association observed. Same. Same. Causation not established."
        with self.store.transaction():
            self.source = self.store.put("source", "S1", {
                "title": "Synthetic source", "origin": "/private/never-return.pdf",
                "raw_hash": self.store.blob(b"%PDF-1.7\nSynthetic fixture, not a rendered paper"),
                "text_hash": self.store.blob(self.text.encode()),
                "access_scope": "full_text", "identity_review": None,
            })
            self.store.put("role_prompt", "Base", {"role": "reader", "template": "Keep uncertainty.", "review": None})
            self.store.put("role_prompt", "Candidate", {"role": "reader", "template": "Inspect evidence.", "review": None})
        self.snapshot = {"S1": {k: self.source[k] for k in ("version", "text_hash", "raw_hash")}}
        self.citation = {"source_id": "S1", "source_version": 1, "text_hash": self.source["text_hash"],
                         "quote": "Association observed.", "start": 0, "end": 21}
        self.put("workbench_answer", "Answer1", {
            "question": "What was observed?", "status": "answered", "source_ids": ["S1"],
            "source_snapshot": self.snapshot, "review_required": True,
            "statements": [{"text": "An association was observed.", "citations": [self.citation]}],
        })
        self.put("causal_worksheet", "Causal1", {
            "title": "Alternative explanations", "source_snapshot": self.snapshot,
            "citations": [self.citation], "review_required": True,
            "hypotheses": [{"explanation": "Confounding", "disconfirming_test": "Replication"}],
        })
        self.put("prompt_experiment", "Experiment1", {
            "prompt_id": "Base", "prompt_version": 1,
            "candidate_id": "Candidate", "candidate_version": 1,
            "status": "running", "calls": 1, "results": [],
            "evaluation_scope": "Phrase checks, not scientific accuracy.",
        })

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def put(self, kind, key, value, expected_version=None):
        with self.store.transaction():
            return self.store.put(kind, key, value, expected_version)

    def update(self, kind, key, changes):
        record = self.store.get(kind, key)
        body = {k: v for k, v in record.items() if k not in {"id", "version"}}
        return self.put(kind, key, {**body, **changes}, record["version"])

    def discover(self, kind="workbench_answer"):
        return bridge.list_artifacts(self.project, kind)["items"][0]

    def read(self, item, **kwargs):
        return bridge.read_artifact(self.project, **item["load"], **kwargs)

    def document(self, **kwargs):
        server = bridge.create_reader(str(self.project))
        result = asyncio.run(server.call_tool("inspect_source_document", {
            "source_id": "S1", "expected_version": 1, **kwargs,
        }))
        if isinstance(result, dict):
            return result
        if isinstance(result, tuple) and len(result) == 2 and isinstance(result[1], dict):
            return result[1]
        return json.loads(next(block.text for block in result if getattr(block, "type", None) == "text"))

    def test_paginated_discovery_and_pinned_json_reassembly(self):
        original = self.store.get("workbench_answer", "Answer1")
        body = {k: v for k, v in original.items() if k not in {"id", "version"}}
        self.put("workbench_answer", "Answer2", {**body, "question": "Second question?"})
        first = bridge.list_artifacts(self.project, "workbench_answer", limit=1)
        self.assertEqual([item["id"] for item in first["items"]], ["Answer1"])
        self.assertEqual(first["next_offset"], 1)
        second = bridge.list_artifacts(self.project, "workbench_answer", offset=1, limit=1)
        self.assertEqual([item["id"] for item in second["items"]], ["Answer2"])
        self.assertIsNone(second["next_offset"])
        self.assertEqual(bridge.list_artifacts(self.project, "workbench_answer", offset=2)["items"], [])

        item = first["items"][0]
        pages, start = [], 0
        while start is not None:
            page = self.read(item, start=start, length=67)
            self.assertEqual(page["start"], start)
            self.assertLessEqual(len(page["text"]), 67)
            self.assertEqual(page["content_hash"], item["load"]["expected_content_hash"])
            self.assertFalse(page["complete"])
            self.assertFalse(page["stale"])
            pages.append(page["text"])
            start = page["next_start"]
            self.assertLess(len(pages), 100)
        value = json.loads("".join(pages))
        self.assertEqual(value["record"]["question"], "What was observed?")
        self.assertFalse(value["context"]["stale"])
        self.assertTrue(self.read(item)["complete"])
        self.assertEqual(self.read(item, start=item["total_characters"])["text"], "")

    def test_record_change_invalidates_pages_even_if_dependencies_unchanged(self):
        item = self.discover()
        self.read(item, length=20)
        self.update("workbench_answer", "Answer1", {"question": "Revised question?"})
        with self.assertRaisesRegex(HarnessError, "changed"):
            self.read(item, start=20)
        fresh = self.discover()
        self.assertEqual(fresh["version"], 2)
        self.assertFalse(fresh["stale"])

    def test_source_change_invalidates_old_pins_and_marks_answer_and_worksheet_stale(self):
        answer = self.discover()
        worksheet = self.discover("causal_worksheet")
        self.update("source", "S1", {"title": "Metadata changed"})
        for item in (answer, worksheet):
            with self.subTest(kind=item["load"]["kind"]), self.assertRaisesRegex(HarnessError, "changed"):
                self.read(item)
            current = self.discover(item["load"]["kind"])
            self.assertTrue(current["stale"])
            page = self.read(current)
            self.assertTrue(page["stale"])
            self.assertIn("not approved scientific evidence", page["scope"])
            self.assertTrue(json.loads(page["text"])["context"]["stale"])

    def test_prompt_change_invalidates_pin_without_mutating_running_experiment(self):
        before = "\n".join(self.store.db.iterdump())
        item = self.discover("prompt_experiment")
        saved = json.loads(self.read(item)["text"])["record"]
        self.assertEqual(saved["status"], "running")
        self.assertEqual(saved["calls"], 1)
        self.assertEqual("\n".join(self.store.db.iterdump()), before)
        self.update("role_prompt", "Candidate", {"template": "Revised candidate"})
        with self.assertRaisesRegex(HarnessError, "changed"):
            self.read(item)
        current = self.discover("prompt_experiment")
        self.assertTrue(current["stale"])
        self.assertEqual(self.store.get("prompt_experiment", "Experiment1")["status"], "running")

    def test_activated_candidate_uses_activated_version(self):
        self.update("role_prompt", "Candidate", {"review": {"reviewer": "Synthetic operator"}})
        self.update("prompt_experiment", "Experiment1", {
            "status": "activated", "activated_prompt": {"id": "Candidate", "version": 2},
        })
        item = self.discover("prompt_experiment")
        self.assertFalse(item["stale"])
        self.update("role_prompt", "Candidate", {"template": "Later revision"})
        with self.assertRaisesRegex(HarnessError, "changed"):
            self.read(item)
        self.assertTrue(self.discover("prompt_experiment")["stale"])

    def test_exact_citation_and_duplicate_quote_use_real_offsets_not_pdf_pages(self):
        value = self.document(citation=self.citation)
        self.assertTrue(value["is_pdf"])
        self.assertNotIn("raw", value)
        self.assertNotIn("origin", value)
        self.assertNotIn("/private/", json.dumps(value))
        self.assertNotIn("page", value["verified_citation"])
        start = self.text.index("Same.", self.text.index("Same.") + 1)
        value = self.document(citation={"quote": "Same.", "start": start, "end": start + 5})
        self.assertEqual(value["verified_citation"]["start"], start)
        for args in ({"citation": {"quote": "Same."}}, {"citation": {"quote": "invented"}},
                     {"expected_version": 2}, {"citation": {**self.citation, "text_hash": "0" * 64}}):
            with self.subTest(args=args), self.assertRaises(ToolError):
                self.document(**args)

    def test_invalid_citation_or_missing_snapshot_is_stale(self):
        self.update("causal_worksheet", "Causal1", {"citations": [{**self.citation, "quote": "Invented quotation"}]})
        self.assertTrue(self.discover("causal_worksheet")["stale"])
        self.update("workbench_answer", "Answer1", {"source_snapshot": None})
        self.assertTrue(self.discover()["stale"])

    def test_malformed_artifact_is_never_fresh_or_an_unhandled_type_error(self):
        for changes in ({"statements": [None]}, {"statements": [{"citations": None}]},
                        {"statements": [{"citations": ["bad citation"]}]}):
            self.update("workbench_answer", "Answer1", changes)
            with self.subTest(changes=changes):
                try:
                    item = self.discover()
                except HarnessError:
                    continue
                self.assertTrue(item["stale"])

    def test_malformed_source_hash_and_prompt_references_are_stale(self):
        self.update("source", "S1", {"text_hash": []})
        self.assertTrue(self.discover()["stale"])
        self.update("prompt_experiment", "Experiment1", {"status": "activated", "activated_prompt": None})
        self.assertTrue(self.discover("prompt_experiment")["stale"])
        self.update("prompt_experiment", "Experiment1", {"status": "running", "prompt_id": {"bad": "reference"}})
        self.assertTrue(self.discover("prompt_experiment")["stale"])

    def test_abstention_and_uncited_planning_worksheet_are_valid_working_context(self):
        self.update("workbench_answer", "Answer1", {
            "status": "abstained", "statements": [], "reason": "No sufficient support.",
        })
        self.assertFalse(self.discover()["stale"])
        self.update("causal_worksheet", "Causal1", {"source_snapshot": {}, "citations": []})
        self.assertFalse(self.discover("causal_worksheet")["stale"])

    def test_invalid_kinds_bounds_and_hashes_rejected(self):
        for kind in ("source", "spend", "../secret", None, [], {}):
            with self.subTest(kind=kind), self.assertRaises(HarnessError):
                bridge.list_artifacts(self.project, kind)
        for args in ({"offset": -1}, {"offset": True}, {"limit": 0}, {"limit": 21}, {"limit": 1.5}):
            with self.subTest(args=args), self.assertRaises(HarnessError):
                bridge.list_artifacts(self.project, "workbench_answer", **args)
        item = self.discover()
        for args in ({"start": -1}, {"length": 0}, {"length": 16001}, {"length": True},
                     {"start": item["total_characters"] + 1}):
            with self.subTest(args=args), self.assertRaises(HarnessError):
                self.read(item, **args)
        for args in ({"expected_version": True}, {"record_id": "../secret"},
                     {"expected_content_hash": "bad"}, {"expected_content_hash": "0" * 64}):
            with self.subTest(args=args), self.assertRaises(HarnessError):
                bridge.read_artifact(self.project, **{**item["load"], **args})

    def test_query_only_connection_rejects_writes_and_preserves_project(self):
        before = "\n".join(self.store.db.iterdump())
        with bridge.read_store(self.project) as store:
            with self.assertRaises(sqlite3.OperationalError):
                store.db.execute("DELETE FROM records")
        for kind in bridge.KINDS:
            self.read(self.discover(kind))
        self.document(citation=self.citation)
        self.assertEqual("\n".join(self.store.db.iterdump()), before)


if __name__ == "__main__":
    unittest.main()
