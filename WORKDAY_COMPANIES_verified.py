# fast_discover.py - stores to file, not just prints
import pandas as pd, re, asyncio, httpx, json

df = pd.read_excel("Workday.xlsx")
companies = df['Company'].tolist()

COMMON_WD = ["wd1","wd5","wd12","wd3","wd501"]
COMMON_SITES = ["External","External_Career_Site","jobs","Global","Search","Primary-External-1"]

def slugify(n): return re.sub(r'[^a-z0-9]', '', n.lower())[:20]

verified = []  # <-- array lives here

async def check(client, name):
    tenant = slugify(name)
    for wd in COMMON_WD:
        for site in COMMON_SITES:
            url = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs"
            try:
                r = await client.post(url, json={"limit":1,"offset":0,"searchText":""}, timeout=5)
                if r.status_code==200 and "jobPostings" in r.text:
                    item = {"label": name, "domain": f"{tenant}.{wd}.myworkdayjobs.com", "company": tenant, "site": site}
                    verified.append(item)  # <-- store here
                    print(f'Found: {name} -> {tenant}.{wd}')
                    return
            except: pass

async def main():
    async with httpx.AsyncClient() as client:
        for i in range(0, len(companies), 20):
            await asyncio.gather(*[check(client, c) for c in companies[i:i+20]])
    
    # AFTER loop, save array to file
    with open("WORKDAY_COMPANIES_verified.json", "w") as f:
        json.dump(verified, f, indent=2)
    
    with open("WORKDAY_COMPANIES_verified.py", "w") as f:
        f.write(f"WORKDAY_COMPANIES = {json.dumps(verified, indent=2)}\n")
    
    print(f"\nDONE: Saved {len(verified)} live companies to:")
    print(f"  - WORKDAY_COMPANIES_verified.json")
    print(f"  - WORKDAY_COMPANIES_verified.py")

asyncio.run(main())