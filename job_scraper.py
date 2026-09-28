"""
=============================================================================
  JOB SCRAPPER v2 — Greenhouse + Workday Only (Scrapling)
  Focused, clean, production-ready
  Output: Daily_Jobs.xlsx + daily_jobs.csv

  Run: python job_scraper.py
  Test Greenhouse: python job_scraper.py --greenhouse openai
  Test Workday: python job_scraper.py --workday netflix
=============================================================================
"""

import os, sys, time, json, random, logging, datetime, re, uuid
import pandas as pd
import requests

try:
    from scrapling.fetchers import Fetcher, StealthyFetcher
    HAS_SCRAPLING = True
except ImportError:
    HAS_SCRAPLING = False

# --- CONFIG — EDIT YOUR TARGETS HERE ---
GREENHOUSE_BOARDS = [
    "openai",
    "stripe",
    "databricks",
    "figma",
    "notion",
    "coinbase",
    "robinhood",
    "anthropic",
    "perplexity",
    "vercel",
]

WORKDAY_COMPANIES = [
    # WORKING - 40 jobs on Actions ✅ you already saw
    {"label": "【entity-Salesforce¦canonical_name=salesforce】", "domain": "【entity-salesforce¦canonical_name=salesforce】.wd12.myworkdayjobs.com", "company": "【entity-salesforce¦canonical_name=salesforce】", "site": "External_Career_Site"},

    # VERIFIED FIXES - change wd1 → wd5 and fix site
    {"label": "【entity-Walmart¦canonical_name=walmart】", "domain": "【entity-walmart¦canonical_name=walmart】.wd5.myworkdayjobs.com", "company": "【entity-walmart¦canonical_name=walmart】", "site": "WalmartExternal"},
    {"label": "【entity-Adobe¦canonical_name=adobe】", "domain": "【entity-adobe¦canonical_name=【entity-adobe¦canonical_name=adobe】】.wd5.myworkdayjobs.com", "company": "【entity-adobe¦canonical_name=adobe】", "site": "external_experienced"},
    {"label": "【entity-Nvidia¦canonical_name=nvidia】", "domain": "【entity-nvidia¦canonical_name=nvidia】.wd5.myworkdayjobs.com", "company": "nvidia", "site": "NVIDIAExternalCareerSite"},
    {"label": "Disney", "domain": "disney.wd5.myworkdayjobs.com", "company": "disney", "site": "disneycareer"},
    {"label": "Workday", "domain": "workday.wd5.myworkdayjobs.com", "company": "workday", "site": "Workday"},

    # REMOVE these - dead on Workday
    # {"label": "Netflix",...} -> migrated to jobs.【entity-netflix¦canonical_name=Netflix】.com, always 422
]
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("job-scraper")

def get_json(url, method="GET", payload=None):
    # Try Scrapling first for datacenter IP
    if HAS_SCRAPLING:
        try:
            if method == "GET":
                page = Fetcher.get(url, stealthy_headers=True, timeout=30000)
            else:
                page = Fetcher.post(url, json=payload, stealthy_headers=True, timeout=30000)
            if page.status in [200, 201]:
                return json.loads(page.text)
            if page.status in [403, 429]:
                log.warning(f"Fetcher blocked {page.status}, trying StealthyFetcher")
                raise Exception("blocked")
        except Exception as e:
            try:
                page = StealthyFetcher.fetch(url, headless=True, solve_cloudflare=True)
                if hasattr(page, 'text'):
                    return json.loads(page.text)
            except Exception as e2:
                log.warning(f"StealthyFetcher failed: {e2}")
    
    # Fallback requests
    try:
        if method == "GET":
            r = requests.get(url, headers=HEADERS, timeout=30)
        else:
            r = requests.post(url, headers=HEADERS, json=payload, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.error(f"Request failed {url}: {e}")
        return None

def scrape_greenhouse(board):
    url = f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs"
    log.info(f"[Greenhouse:{board}] GET {url}")
    data = get_json(url)
    if not data:
        return []
    
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    out = []
    for j in jobs:
        loc = j.get("location", {})
        loc_name = loc.get("name", "") if isinstance(loc, dict) else str(loc)
        out.append({
            "Company": board.capitalize(),
            "Title": j.get("title",""),
            "Location": loc_name,
            "Department": ", ".join([d.get("name","") for d in j.get("departments",[])]) if j.get("departments") else "",
            "URL": j.get("absolute_url",""),
            "Updated": j.get("updated_at",""),
            "Source": "Greenhouse",
        })
    log.info(f"[Greenhouse:{board}] {len(out)} jobs")
    return out

def scrape_workday(cfg):
    label = cfg["label"]
    url = f"https://{cfg['domain']}/wday/cxs/{cfg['company']}/{cfg['site']}/jobs"
    log.info(f"[Workday:{label}] POST {url}")
    all_jobs = []
    offset = 0
    limit = 20
    
    while True:
        payload = {"appliedFacets": {}, "limit": limit, "offset": offset, "searchText": ""}
        data = get_json(url, method="POST", payload=payload)
        if not data:
            break
        postings = data.get("jobPostings", [])
        total = data.get("total", 0)
        if not postings:
            break
        
        for j in postings:
            title = j.get("title","")
            loc = j.get("locationsText","") or ", ".join([l.get("displayName","") if isinstance(l, dict) else str(l) for l in j.get("locations",[])]) if j.get("locations") else ""
            ext = j.get("externalPath","")
            job_url = f"https://{cfg['domain']}{ext}" if ext else ""
            all_jobs.append({
                "Company": label,
                "Title": title,
                "Location": loc,
                "Department": "",
                "URL": job_url,
                "Updated": j.get("postedOn","") or j.get("updatedAt",""),
                "Source": "Workday",
            })
        
        if len(all_jobs) >= total or len(postings) < limit or offset > 500:
            break
        offset += limit
        time.sleep(random.uniform(1,2))
    
    log.info(f"[Workday:{label}] {len(all_jobs)} jobs")
    return all_jobs

# --- API INGESTION ---
# Delivery pipeline: deduplicated jobs -> batched HTTP POST -> ingestion API -> MongoDB.
# The scraping functions above are untouched; everything below only handles delivery.

INGEST_BATCH_SIZE_DEFAULT = 500
INGEST_MAX_RETRIES_DEFAULT = 5
INGEST_MAX_DELAY_SECONDS = 30
INGEST_REQUEST_TIMEOUT_SECONDS = 60

# Temporary failures worth retrying with backoff.
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


class IngestError(Exception):
    """A batch permanently failed to ingest (retries exhausted or fatal status)."""


class IngestConfigError(IngestError):
    """Ingestion is enabled but misconfigured (missing URL/key, invalid settings)."""


def ingestion_enabled():
    return os.environ.get("ENABLE_INGEST", "false").strip().lower() in ("1", "true", "yes")


def _env_int(name, default, minimum=1):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise IngestConfigError(f"{name} must be an integer, got {raw!r}")
    if value < minimum:
        raise IngestConfigError(f"{name} must be >= {minimum}, got {value}")
    return value


def get_ingest_config():
    """Return (api_url, api_key, batch_size, max_retries) or raise IngestConfigError."""
    api_url = os.environ.get("INGEST_API_URL", "").strip()
    api_key = os.environ.get("INGEST_API_KEY", "")
    if not api_url:
        raise IngestConfigError("ENABLE_INGEST=true but INGEST_API_URL is missing")
    if not api_key:
        raise IngestConfigError("ENABLE_INGEST=true but INGEST_API_KEY is missing")
    batch_size = _env_int("INGEST_BATCH_SIZE", INGEST_BATCH_SIZE_DEFAULT)
    max_retries = _env_int("INGEST_MAX_RETRIES", INGEST_MAX_RETRIES_DEFAULT)
    return api_url, api_key, batch_size, max_retries


def generate_run_id():
    github_run_id = os.environ.get("GITHUB_RUN_ID", "").strip()
    if github_run_id:
        return f"gha-{github_run_id}"
    return f"local-{uuid.uuid4()}"


def chunk_jobs(jobs, batch_size):
    """Yield successive batches of at most batch_size jobs."""
    if batch_size < 1:
        raise ValueError(f"batch_size must be >= 1, got {batch_size}")
    for i in range(0, len(jobs), batch_size):
        yield jobs[i:i + batch_size]


def _response_snippet(resp, limit=500):
    try:
        text = resp.text or ""
    except Exception:
        text = ""
    return text[:limit]


def post_jobs_batch(session, api_url, api_key, run_id, jobs, batch_no=1, total_batches=1, max_retries=5):
    """POST one batch. Retries temporary failures; returns the API response dict."""
    payload = {"runId": run_id, "jobs": jobs}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    last_error = "unknown error"
    for attempt in range(1, max_retries + 1):
        status = None
        try:
            resp = session.post(api_url, json=payload, headers=headers, timeout=INGEST_REQUEST_TIMEOUT_SECONDS)
            status = resp.status_code
        except requests.RequestException as e:
            last_error = f"network error: {e}"
        else:
            if 200 <= status < 300:
                try:
                    data = resp.json()
                except ValueError:
                    raise IngestError(f"batch {batch_no}/{total_batches} runId={run_id}: HTTP {status} with invalid JSON response")
                log.info(f"[INGEST] batch={batch_no}/{total_batches} received={data.get('received', 0)} inserted={data.get('inserted', 0)} updated={data.get('updated', 0)}")
                return data
            if status not in RETRYABLE_STATUS_CODES:
                raise IngestError(f"batch {batch_no}/{total_batches} runId={run_id}: fatal HTTP {status}: {_response_snippet(resp)}")
            last_error = f"HTTP {status}: {_response_snippet(resp)}"
        if attempt < max_retries:
            delay = min(2 ** (attempt - 1), INGEST_MAX_DELAY_SECONDS) + random.uniform(0, 1)
            log.warning(f"[INGEST] batch {batch_no}/{total_batches} attempt {attempt}/{max_retries} failed ({last_error}); retrying in {delay:.1f}s")
            time.sleep(delay)
    raise IngestError(f"batch {batch_no}/{total_batches} runId={run_id}: failed after {max_retries} attempts: {last_error}")


def records_from_dataframe(df):
    """Convert the deduplicated DataFrame back to job dicts (NaN/None -> "")."""
    records = []
    for record in df.to_dict(orient="records"):
        records.append({k: ("" if pd.isna(v) else v) for k, v in record.items()})
    return records


def ingest_jobs(jobs):
    """Send deduplicated jobs to the ingestion API in batches.

    Returns a summary dict, or None when ingestion is disabled.
    Raises IngestError when a batch permanently fails or config is invalid.
    """
    if not ingestion_enabled():
        log.info("[INGEST] disabled (ENABLE_INGEST != true); skipping API ingestion")
        return None
    api_url, api_key, batch_size, max_retries = get_ingest_config()
    run_id = generate_run_id()
    if not jobs:
        log.warning(f"[INGEST] runId={run_id}: no jobs to ingest")
        return {"runId": run_id, "totalJobs": 0, "batchSize": batch_size, "batches": 0,
                "successfulBatches": 0, "failedBatches": 0, "inserted": 0, "updated": 0, "sources": {}}
    batches = list(chunk_jobs(jobs, batch_size))
    log.info(f"[INGEST] Starting runId={run_id} total_jobs={len(jobs)} batches={len(batches)} batch_size={batch_size}")
    session = requests.Session()
    inserted_total = 0
    updated_total = 0
    sources_total = {}
    for i, batch in enumerate(batches, start=1):
        log.info(f"[INGEST] batch {i}/{len(batches)} sending {len(batch)} jobs")
        try:
            data = post_jobs_batch(session, api_url, api_key, run_id, batch, i, len(batches), max_retries)
        except IngestError as e:
            log.error(f"[INGEST] FAILED batch {i}/{len(batches)} runId={run_id}: {e}")
            raise
        inserted_total += int(data.get("inserted", 0) or 0)
        updated_total += int(data.get("updated", 0) or 0)
        for source, count in (data.get("sources") or {}).items():
            sources_total[source] = sources_total.get(source, 0) + int(count or 0)
    log.info(f"[INGEST] Completed runId={run_id} batches={len(batches)} inserted={inserted_total} updated={updated_total}")
    print("==================================================")
    print("INGESTION SUMMARY")
    print("==================================================")
    print(f"\nRun ID: {run_id}")
    print(f"Total jobs: {len(jobs)}")
    print(f"Batch size: {batch_size}")
    print(f"Batches: {len(batches)}")
    print(f"Successful batches: {len(batches)}")
    print(f"Failed batches: 0")
    print(f"\nInserted: {inserted_total}")
    print(f"Updated: {updated_total}")
    print("")
    for source, count in sorted(sources_total.items()):
        print(f"{source}: {count}")
    print("\n==================================================")
    return {"runId": run_id, "totalJobs": len(jobs), "batchSize": batch_size, "batches": len(batches),
            "successfulBatches": len(batches), "failedBatches": 0,
            "inserted": inserted_total, "updated": updated_total, "sources": sources_total}


def run_all():
    all_jobs = []
    
    for board in GREENHOUSE_BOARDS:
        try:
            jobs = scrape_greenhouse(board)
            all_jobs.extend(jobs)
        except Exception as e:
            log.error(f"Greenhouse {board} failed: {e}")
        time.sleep(random.uniform(0.5,1.5))
    
    for cfg in WORKDAY_COMPANIES:
        try:
            jobs = scrape_workday(cfg)
            all_jobs.extend(jobs)
        except Exception as e:
            log.error(f"Workday {cfg['label']} failed: {e}")
        time.sleep(random.uniform(1,2))
    
    if not all_jobs:
        log.warning("No jobs found")
        return
    
    df = pd.DataFrame(all_jobs)
    # Deduplicate by URL
    df.drop_duplicates(subset=["URL"], inplace=True)
    
    # Save
    ts = datetime.datetime.now().strftime("%d %b %Y %H:%M")
    df.to_csv("daily_jobs.csv", index=False)
    
    # Excel with formatting
    with pd.ExcelWriter("Daily_Jobs.xlsx", engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="All Jobs", index=False)
        # Per-company sheets
        for comp in df["Company"].unique():
            sub = df[df["Company"]==comp]
            sheet = re.sub(r'[\[\]*?:/\\]', '', comp)[:31]
            sub.to_excel(writer, sheet_name=sheet, index=False)
    
    log.info(f"Saved {len(df)} jobs -> Daily_Jobs.xlsx + daily_jobs.csv | Run: {ts}")
    print(df.head(20).to_string(index=False))

    # Deliver the same deduplicated jobs to the ingestion API (if enabled).
    try:
        ingest_jobs(records_from_dataframe(df))
    except IngestError as e:
        log.error(f"Ingestion failed, failing run: {e}")
        sys.exit(1)

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--greenhouse", type=str, help="Test single greenhouse board token")
    p.add_argument("--workday", type=str, help="Test single workday label or company")
    args = p.parse_args()
    
    if args.greenhouse:
        jobs = scrape_greenhouse(args.greenhouse)
        print(f"\n{len(jobs)} jobs from {args.greenhouse}")
        print(pd.DataFrame(jobs).head(10).to_string(index=False))
    elif args.workday:
        cfg = next((c for c in WORKDAY_COMPANIES if c["label"].lower()==args.workday.lower() or c["company"].lower()==args.workday.lower()), None)
        if not cfg:
            cfg = {"label": args.workday, "domain": f"{args.workday}.wd1.myworkdayjobs.com", "company": args.workday, "site": "External"}
        jobs = scrape_workday(cfg)
        print(f"\n{len(jobs)} jobs from {cfg['label']}")
        print(pd.DataFrame(jobs).head(10).to_string(index=False))
    else:
        run_all()
