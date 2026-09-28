# pip install requests
import pandas as pd, requests, re, time

df = pd.read_excel("Workday.xlsx")
companies = df['Company'].tolist()

COMMON_WD = ["wd1","wd5","wd12","wd3","wd2","wd501"]
COMMON_SITES = ["External","External_Career_Site","jobs","Global","Search","careers","Primary-External-1"]

def slugify(name):
    return re.sub(r'[^a-z0-9]', '', name.lower())[:20]

for name in companies:
    tenant = slugify(name)
    for wd in COMMON_WD:
        for site in COMMON_SITES:
            url = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs"
            try:
                r = requests.post(url, json={"limit":1,"offset":0,"searchText":""}, timeout=5)
                if r.status_code==200 and "jobPostings" in r.text:
                    print(f'{{"label": "{name}", "domain": "{tenant}.{wd}.myworkdayjobs.com", "company": "{tenant}", "site": "{site}"}},')
                    break
            except: pass