"""Ingestion pipeline tests: batching, run IDs, retries, auth, failure behavior.

No real scraping and no real HTTP: all network calls are mocked.

Run from the repository root:
    .venv/bin/python -m unittest discover -s tests -v
"""

import io
import json
import os
import sys
import tempfile
import unittest
import uuid
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import job_scraper
import requests


def make_job(i, source="Workday", company="Disney"):
    return {
        "Company": company,
        "Title": f"Software Engineer {i}",
        "Location": "Orlando, FL",
        "Department": "",
        "URL": f"https://example.com/job/{source}/{i}",
        "Updated": "2026-09-28",
        "Source": source,
    }


def success_payload(received, inserted, updated, sources):
    return {
        "success": True,
        "runId": "test-run",
        "received": received,
        "inserted": inserted,
        "updated": updated,
        "sources": sources,
    }


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload
        self.text = "" if payload is None else json.dumps(payload)

    def json(self):
        if self._payload is None:
            raise ValueError("No JSON body")
        return self._payload


ENV_KEYS = ["ENABLE_INGEST", "INGEST_API_URL", "INGEST_API_KEY",
            "INGEST_BATCH_SIZE", "INGEST_MAX_RETRIES", "GITHUB_RUN_ID"]


class IngestTestCase(unittest.TestCase):
    def setUp(self):
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        os.environ["ENABLE_INGEST"] = "true"
        os.environ["INGEST_API_URL"] = "https://example.com/internal/jobs/ingest"
        os.environ["INGEST_API_KEY"] = "test-key"
        sleep_patcher = mock.patch("time.sleep")
        self.mock_sleep = sleep_patcher.start()
        self.addCleanup(sleep_patcher.stop)

    def tearDown(self):
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        for k, v in self._saved_env.items():
            if v is not None:
                os.environ[k] = v

    def mock_session(self, responses):
        session = mock.Mock()
        session.post.side_effect = responses
        return session


class ChunkJobsTest(IngestTestCase):
    def test_splits_into_full_and_partial_batches(self):
        jobs = [make_job(i) for i in range(1200)]
        batches = list(job_scraper.chunk_jobs(jobs, 500))
        self.assertEqual([len(b) for b in batches], [500, 500, 200])
        self.assertEqual(batches[0][0]["URL"], jobs[0]["URL"])
        self.assertEqual(batches[-1][-1]["URL"], jobs[-1]["URL"])

    def test_1000_jobs_two_batches(self):
        jobs = [make_job(i) for i in range(1000)]
        batches = list(job_scraper.chunk_jobs(jobs, 500))
        self.assertEqual(len(batches), 2)

    def test_10000_jobs_twenty_batches(self):
        jobs = [make_job(i) for i in range(10000)]
        batches = list(job_scraper.chunk_jobs(jobs, 500))
        self.assertEqual(len(batches), 20)
        self.assertTrue(all(len(b) == 500 for b in batches))

    def test_empty_list_yields_no_batches(self):
        self.assertEqual(list(job_scraper.chunk_jobs([], 500)), [])

    def test_invalid_batch_size_raises(self):
        with self.assertRaises(ValueError):
            list(job_scraper.chunk_jobs([make_job(0)], 0))


class RunIdTest(IngestTestCase):
    def test_uses_github_run_id_when_present(self):
        os.environ["GITHUB_RUN_ID"] = "123456789"
        self.assertEqual(job_scraper.generate_run_id(), "gha-123456789")

    def test_falls_back_to_local_uuid(self):
        run_id = job_scraper.generate_run_id()
        self.assertTrue(run_id.startswith("local-"))
        uuid.UUID(run_id.removeprefix("local-"))  # raises if not a valid UUID


class PostBatchTest(IngestTestCase):
    def test_success_returns_response_dict(self):
        payload = success_payload(2, 2, 0, {"Workday": 2})
        session = self.mock_session([FakeResponse(200, payload)])
        result = job_scraper.post_jobs_batch(
            session, "https://example.com/internal/jobs/ingest",
            "test-key", "run-1", [make_job(0)])
        self.assertEqual(result, payload)
        self.assertEqual(session.post.call_count, 1)

    def test_request_construction(self):
        jobs = [make_job(0), make_job(1)]
        session = self.mock_session([FakeResponse(200, success_payload(2, 2, 0, {"Workday": 2}))])
        job_scraper.post_jobs_batch(
            session, "https://example.com/internal/jobs/ingest",
            "test-key", "run-abc", jobs, batch_no=3, total_batches=20)
        (url,), kwargs = session.post.call_args
        self.assertEqual(url, "https://example.com/internal/jobs/ingest")
        self.assertEqual(kwargs["json"], {"runId": "run-abc", "jobs": jobs})
        self.assertEqual(kwargs["headers"]["Content-Type"], "application/json")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-key")

    def test_does_not_log_api_key(self):
        session = self.mock_session([FakeResponse(200, success_payload(1, 1, 0, {"Workday": 1}))])
        with self.assertLogs("job-scraper", level="INFO") as logs:
            job_scraper.post_jobs_batch(
                session, "https://example.com/internal/jobs/ingest",
                "test-key", "run-1", [make_job(0)])
        output = "\n".join(logs.output)
        self.assertNotIn("test-key", output)
        self.assertNotIn("Bearer", output)

    def test_429_retries_with_backoff_then_succeeds(self):
        session = self.mock_session([
            FakeResponse(429), FakeResponse(429),
            FakeResponse(200, success_payload(1, 1, 0, {"Workday": 1})),
        ])
        result = job_scraper.post_jobs_batch(
            session, "https://example.com/internal/jobs/ingest",
            "test-key", "run-1", [make_job(0)])
        self.assertEqual(session.post.call_count, 3)
        self.assertEqual(result["inserted"], 1)
        delays = [c.args[0] for c in self.mock_sleep.call_args_list]
        self.assertEqual(len(delays), 2)
        self.assertGreaterEqual(delays[0], 1)
        self.assertLess(delays[0], 2.5)
        self.assertGreaterEqual(delays[1], 2)
        self.assertLess(delays[1], 3.5)

    def test_500_retries(self):
        session = self.mock_session([
            FakeResponse(500),
            FakeResponse(200, success_payload(1, 1, 0, {"Workday": 1})),
        ])
        job_scraper.post_jobs_batch(
            session, "https://example.com/internal/jobs/ingest",
            "test-key", "run-1", [make_job(0)])
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(self.mock_sleep.call_count, 1)

    def test_network_error_retries(self):
        session = self.mock_session([
            requests.RequestException("connection reset"),
            FakeResponse(200, success_payload(1, 1, 0, {"Workday": 1})),
        ])
        job_scraper.post_jobs_batch(
            session, "https://example.com/internal/jobs/ingest",
            "test-key", "run-1", [make_job(0)])
        self.assertEqual(session.post.call_count, 2)

    def test_401_fails_without_retry(self):
        session = self.mock_session([FakeResponse(401, {"error": "bad key"})])
        with self.assertRaises(job_scraper.IngestError) as ctx:
            job_scraper.post_jobs_batch(
                session, "https://example.com/internal/jobs/ingest",
                "test-key", "run-1", [make_job(0)])
        self.assertEqual(session.post.call_count, 1)
        self.assertIn("401", str(ctx.exception))

    def test_client_errors_fail_without_retry(self):
        for status in (400, 403, 404):
            with self.subTest(status=status):
                session = self.mock_session([FakeResponse(status, {"error": "nope"})])
                with self.assertRaises(job_scraper.IngestError):
                    job_scraper.post_jobs_batch(
                        session, "https://example.com/internal/jobs/ingest",
                        "test-key", "run-1", [make_job(0)])
                self.assertEqual(session.post.call_count, 1)

    def test_exhausts_retries_then_raises(self):
        session = self.mock_session([FakeResponse(503)] * 5)
        with self.assertRaises(job_scraper.IngestError) as ctx:
            job_scraper.post_jobs_batch(
                session, "https://example.com/internal/jobs/ingest",
                "test-key", "run-9", [make_job(0)],
                batch_no=2, total_batches=4, max_retries=3)
        self.assertEqual(session.post.call_count, 3)
        self.assertEqual(self.mock_sleep.call_count, 2)
        message = str(ctx.exception)
        self.assertIn("2/4", message)
        self.assertIn("run-9", message)


class IngestJobsTest(IngestTestCase):
    def test_disabled_skips_http_entirely(self):
        os.environ["ENABLE_INGEST"] = "false"
        with mock.patch("requests.Session") as mock_session_cls:
            result = job_scraper.ingest_jobs([make_job(0)])
        self.assertIsNone(result)
        mock_session_cls.assert_not_called()

    def test_missing_url_fails_fast_without_http(self):
        del os.environ["INGEST_API_URL"]
        with mock.patch("requests.Session") as mock_session_cls:
            with self.assertRaises(job_scraper.IngestConfigError):
                job_scraper.ingest_jobs([make_job(0)])
        mock_session_cls.assert_not_called()

    def test_missing_key_fails_fast_without_http(self):
        del os.environ["INGEST_API_KEY"]
        with mock.patch("requests.Session"):
            with self.assertRaises(job_scraper.IngestConfigError):
                job_scraper.ingest_jobs([make_job(0)])

    def test_invalid_batch_size_fails_fast(self):
        for bad in ("abc", "0", "-5"):
            with self.subTest(bad=bad):
                os.environ["INGEST_BATCH_SIZE"] = bad
                with self.assertRaises(job_scraper.IngestConfigError):
                    job_scraper.ingest_jobs([make_job(0)])

    def test_1000_jobs_produce_two_http_calls_with_same_run_id(self):
        os.environ["GITHUB_RUN_ID"] = "777"
        session = self.mock_session([
            FakeResponse(200, success_payload(500, 400, 100, {"Workday": 500})),
            FakeResponse(200, success_payload(500, 450, 50, {"Workday": 500})),
        ])
        jobs = [make_job(i) for i in range(1000)]
        with mock.patch("requests.Session", return_value=session):
            with redirect_stdout(io.StringIO()):
                summary = job_scraper.ingest_jobs(jobs)
        self.assertEqual(session.post.call_count, 2)
        bodies = [c.kwargs["json"] for c in session.post.call_args_list]
        self.assertEqual([len(b["jobs"]) for b in bodies], [500, 500])
        self.assertEqual(bodies[0]["runId"], "gha-777")
        self.assertEqual(bodies[1]["runId"], "gha-777")
        self.assertEqual(summary["runId"], "gha-777")

    def test_aggregates_summary_from_api_responses(self):
        session = self.mock_session([
            FakeResponse(200, success_payload(500, 420, 80, {"Greenhouse": 230, "Workday": 270})),
            FakeResponse(200, success_payload(200, 150, 50, {"Greenhouse": 200})),
        ])
        jobs = [make_job(i) for i in range(700)]
        with mock.patch("requests.Session", return_value=session):
            buf = io.StringIO()
            with redirect_stdout(buf):
                summary = job_scraper.ingest_jobs(jobs)
        self.assertEqual(summary["totalJobs"], 700)
        self.assertEqual(summary["batches"], 2)
        self.assertEqual(summary["successfulBatches"], 2)
        self.assertEqual(summary["failedBatches"], 0)
        self.assertEqual(summary["inserted"], 570)
        self.assertEqual(summary["updated"], 130)
        self.assertEqual(summary["sources"], {"Greenhouse": 430, "Workday": 270})
        output = buf.getvalue()
        self.assertIn("INGESTION SUMMARY", output)
        self.assertIn("Run ID: ", output)
        self.assertIn("Inserted: 570", output)

    def test_failed_batch_raises_without_swallowing(self):
        os.environ["INGEST_MAX_RETRIES"] = "2"
        session = self.mock_session([FakeResponse(500)] * 5)
        with mock.patch("requests.Session", return_value=session):
            with self.assertRaises(job_scraper.IngestError):
                job_scraper.ingest_jobs([make_job(0)])
        self.assertEqual(session.post.call_count, 2)


class RecordsFromDataframeTest(IngestTestCase):
    def test_converts_and_sanitizes_missing_values(self):
        import pandas as pd
        df = pd.DataFrame([
            {"Company": "Disney", "Title": "Eng", "Location": "Orlando, FL",
             "Department": float("nan"), "URL": "https://example.com/1",
             "Updated": None, "Source": "Workday"},
        ])
        records = job_scraper.records_from_dataframe(df)
        self.assertEqual(records, [{
            "Company": "Disney", "Title": "Eng", "Location": "Orlando, FL",
            "Department": "", "URL": "https://example.com/1",
            "Updated": "", "Source": "Workday",
        }])


class RunAllDeliveryTest(IngestTestCase):
    def _run_all(self, post_side_effect):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        old_cwd = os.getcwd()
        os.chdir(tmp.name)
        self.addCleanup(os.chdir, old_cwd)
        session = self.mock_session(post_side_effect)
        gh_patcher = mock.patch.object(job_scraper, "scrape_greenhouse",
                                       return_value=[make_job(1, "Greenhouse", "OpenAI")])
        wd_patcher = mock.patch.object(job_scraper, "scrape_workday",
                                       return_value=[make_job(2, "Workday", "Disney")])
        session_patcher = mock.patch("requests.Session", return_value=session)
        gh_patcher.start(); wd_patcher.start(); session_patcher.start()
        self.addCleanup(gh_patcher.stop); self.addCleanup(wd_patcher.stop); self.addCleanup(session_patcher.stop)
        return session

    def test_failed_ingestion_fails_run_after_writing_files(self):
        os.environ["INGEST_MAX_RETRIES"] = "1"
        self._run_all([FakeResponse(500)] * 5)
        with self.assertRaises(SystemExit) as ctx:
            with redirect_stdout(io.StringIO()):
                job_scraper.run_all()
        self.assertEqual(ctx.exception.code, 1)
        # CSV/XLSX are still produced before the ingestion failure.
        self.assertTrue(os.path.exists("daily_jobs.csv"))
        self.assertTrue(os.path.exists("Daily_Jobs.xlsx"))

    def test_successful_run_ingests_and_summarizes(self):
        self._run_all([FakeResponse(200, success_payload(2, 2, 0, {"Greenhouse": 1, "Workday": 1}))])
        buf = io.StringIO()
        with redirect_stdout(buf):
            job_scraper.run_all()  # must not raise
        self.assertIn("INGESTION SUMMARY", buf.getvalue())
        self.assertIn("Total jobs: 2", buf.getvalue())

    def test_disabled_ingestion_keeps_files_only_behavior(self):
        os.environ["ENABLE_INGEST"] = "false"
        session = self._run_all([FakeResponse(200, success_payload(2, 2, 0, {}))])
        with redirect_stdout(io.StringIO()):
            job_scraper.run_all()
        session.post.assert_not_called()
        self.assertTrue(os.path.exists("daily_jobs.csv"))


if __name__ == "__main__":
    unittest.main()
