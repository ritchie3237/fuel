#!/usr/bin/env python3
"""Pull Oura Ring data (Oura API v2) and write oura-data.json for the Health dashboard.

Decoupled from garmin-data.json on purpose: the dashboard loads both files and
merges them client-side (Oura wins the recovery metrics, Garmin wins training).
Run standalone any time, or from the weekly Garmin report task's dashboard step.

Token: read from ~/.ouraring_token (a personal access token from
cloud.ouraring.com/personal-access-tokens). Never commit the token.
"""
import json, os, sys, urllib.request, urllib.error
from datetime import date, timedelta

TOKEN_PATH = os.path.expanduser("~/.ouraring_token")
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "oura-data.json")
BASE = "https://api.ouraring.com/v2/usercollection"
DAYS = 45  # rolling window to pull


def load_token():
    try:
        with open(TOKEN_PATH) as f:
            return f.read().strip()
    except FileNotFoundError:
        sys.exit(f"No Oura token at {TOKEN_PATH}. Create one at "
                 "cloud.ouraring.com/personal-access-tokens and save it there.")


def get(endpoint, token, start, end):
    url = f"{BASE}/{endpoint}?start_date={start}&end_date={end}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r).get("data", [])
    except urllib.error.HTTPError as e:
        sys.exit(f"Oura API {endpoint} -> HTTP {e.code}: {e.read().decode()[:200]}")


def mmdd(day):  # "2026-07-22" -> "07-22"
    return day[5:]


def readiness_label(s):
    if s is None:
        return ""
    if s >= 85:
        return "Optimal — well recovered"
    if s >= 70:
        return "Good — ready to train"
    if s >= 60:
        return "Fair — moderate recovery"
    return "Pay attention — prioritize rest"


def main():
    token = load_token()
    today = date.today()
    start = today - timedelta(days=DAYS)
    # Oura's period endpoints treat end_date as exclusive, so query through
    # tomorrow to include last night's sleep.
    s, e = start.isoformat(), (today + timedelta(days=1)).isoformat()

    daily_sleep = get("daily_sleep", token, s, e)          # score per day
    sleep = get("sleep", token, s, e)                      # detailed stages/hrv/rhr/breath
    readiness = get("daily_readiness", token, s, e)        # score + temp deviation
    spo2 = get("daily_spo2", token, s, e)                  # blood oxygen

    # Pick the main sleep period per day (longest total_sleep_duration; ignore naps).
    main_sleep = {}
    for x in sleep:
        d = x.get("day")
        if not d or not x.get("total_sleep_duration"):
            continue
        if d not in main_sleep or x["total_sleep_duration"] > main_sleep[d]["total_sleep_duration"]:
            main_sleep[d] = x

    sleep_score = {x["day"]: x.get("score") for x in daily_sleep if x.get("day")}
    ready_by_day = {x["day"]: x for x in readiness if x.get("day")}
    spo2_by_day = {x["day"]: x for x in spo2 if x.get("day")}

    def trend(fn, source):  # build sorted [{d,v}] dropping None
        out = []
        for d in sorted(source):
            v = fn(d)
            if v is not None:
                out.append({"d": mmdd(d), "v": v})
        return out

    trends = {
        "sleepHours": trend(lambda d: round(main_sleep[d]["total_sleep_duration"] / 3600, 1)
                            if d in main_sleep else None, main_sleep),
        "sleepScore": trend(lambda d: sleep_score.get(d), sleep_score),
        "hrv": trend(lambda d: main_sleep[d].get("average_hrv") if d in main_sleep else None, main_sleep),
        "rhr": trend(lambda d: main_sleep[d].get("lowest_heart_rate") if d in main_sleep else None, main_sleep),
        "readiness": trend(lambda d: ready_by_day[d].get("score"), ready_by_day),
        "tempDeviation": trend(lambda d: round(ready_by_day[d]["temperature_deviation"], 2)
                               if ready_by_day[d].get("temperature_deviation") is not None else None,
                               ready_by_day),
    }

    # Latest snapshot — align on the most recent day that has a main sleep record.
    latest = None
    if main_sleep:
        d = max(main_sleep)
        sl = main_sleep[d]
        rd = ready_by_day.get(d, {})
        sp = spo2_by_day.get(d, {})
        spo2_avg = (sp.get("spo2_percentage") or {}).get("average")
        latest = {
            "day": d,
            "sleepHours": round(sl["total_sleep_duration"] / 3600, 1),
            "sleepScore": sleep_score.get(d),
            "efficiency": sl.get("efficiency"),
            "hrv": sl.get("average_hrv"),
            "rhr": sl.get("lowest_heart_rate"),
            "readiness": rd.get("score"),
            "readinessLabel": readiness_label(rd.get("score")),
            "tempDeviation": round(rd["temperature_deviation"], 2)
                             if rd.get("temperature_deviation") is not None else None,
            "respiratoryRate": sl.get("average_breath"),
            "spo2": round(spo2_avg, 1) if spo2_avg is not None else None,
            "stages": {
                "deepMin": round(sl.get("deep_sleep_duration", 0) / 60),
                "remMin": round(sl.get("rem_sleep_duration", 0) / 60),
                "lightMin": round(sl.get("light_sleep_duration", 0) / 60),
                "awakeMin": round(sl.get("awake_time", 0) / 60),
            },
        }

    out = {
        "generated": today.isoformat(),
        "source": "oura",
        "nights": len(main_sleep),
        "latest": latest,
        "trends": trends,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {OUT_PATH}: {len(main_sleep)} nights, latest={latest['day'] if latest else 'none'}")


if __name__ == "__main__":
    main()
