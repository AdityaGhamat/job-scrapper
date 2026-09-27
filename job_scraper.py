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

import os, sys, time, json, random, logging, datetime, re
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
