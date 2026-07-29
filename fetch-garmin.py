#!/usr/bin/env python3
"""Pull Garmin Connect data and update garmin-data.json for the Health dashboard.

Companion to fetch-oura.py. Run both, then commit:

    python3 fetch-garmin.py && python3 fetch-oura.py

Requires: pip install garminconnect garth

Credentials, in order of preference:
  1. A cached garth session in ~/.garminconnect (written on first login, so MFA
     is a one-time prompt). Never commit it.
  2. GARMIN_EMAIL / GARMIN_PASSWORD environment variables.
  3. ~/.garmin_credentials — two lines, email then password.

MERGE, DON'T CLOBBER: this script refreshes only *measured* fields. Anything
hand-curated — recommendations prose, the goal block, stepGoal/bmiTarget/
vigorousTarget, readinessLevel wording — is read from the existing
garmin-data.json and written back untouched. Every field that could not be
refreshed is listed in the run summary, so a stale number never passes
silently as a fresh one.
"""
import json, os, sys
from datetime import date, timedelta

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "garmin-data.json")
TOKEN_DIR = os.path.expanduser("~/.garminconnect")
CRED_PATH = os.path.expanduser("~/.garmin_credentials")

TREND_DAYS = 28        # rolling window for daily trends
WEEKLY_WEEKS = 12      # weekly mileage bars
POLARIZED_DAYS = 30    # window for the easy/gray/hard split
Z3_FLOOR = 129         # Z2/Z3 boundary, bpm — keep in sync with garmin.html's caption
METERS_PER_MILE = 1609.344

stale = []   # fields we kept from the previous file
notes = []   # non-fatal problems worth printing


def warn(field, err):
    stale.append(field)
    notes.append(f"  ! {field}: {type(err).__name__}: {str(err)[:120]}")


def safe(field, fn, default=None):
    """Run fn(); on any failure record the field as stale and return default."""
    try:
        v = fn()
        if v is None:
            stale.append(field)
        return v if v is not None else default
    except Exception as e:  # noqa: BLE001 - one bad endpoint shouldn't kill the run
        warn(field, e)
        return default


def dig(obj, *keys, default=None):
    """obj['a']['b'][0]['c'] without the KeyError/IndexError dance."""
    for k in keys:
        if obj is None:
            return default
        try:
            obj = obj[k]
        except (KeyError, IndexError, TypeError):
            return default
    return obj if obj is not None else default


def mmdd(day):  # "2026-07-22" -> "07-22"
    return str(day)[5:10]


def hhmmss(secs):
    if not secs:
        return None
    secs = int(round(secs))
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def week_start(d):
    """Sunday-start week, matching the existing weekly buckets."""
    return d - timedelta(days=(d.weekday() + 1) % 7)


def merge_trend(previous, fresh, keep=TREND_DAYS):
    """Union of old and new points, newest last, deduped by date."""
    by_day = {p["d"]: p for p in (previous or [])}
    for p in fresh or []:
        by_day[p["d"]] = p
    ordered = [by_day[d] for d in sorted(by_day)]
    return ordered[-keep:]


def login():
    try:
        from garminconnect import Garmin
    except ImportError:
        sys.exit("Missing dependency. Run: pip install garminconnect garth")

    if os.path.isdir(TOKEN_DIR):
        try:
            api = Garmin()
            api.login(TOKEN_DIR)
            return api
        except Exception as e:  # noqa: BLE001 - fall through to password login
            print(f"Cached session at {TOKEN_DIR} unusable ({e}); logging in fresh.")

    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")
    if not (email and password) and os.path.exists(CRED_PATH):
        with open(CRED_PATH) as f:
            lines = [ln.strip() for ln in f if ln.strip()]
        if len(lines) >= 2:
            email, password = lines[0], lines[1]
    if not (email and password):
        sys.exit(
            "No Garmin credentials. Set GARMIN_EMAIL/GARMIN_PASSWORD, or write "
            f"email and password on two lines in {CRED_PATH}."
        )

    api = Garmin(email, password)
    api.login()  # prompts for MFA if the account requires it
    try:
        api.garth.dump(TOKEN_DIR)
        print(f"Saved session to {TOKEN_DIR} — future runs skip the password.")
    except Exception as e:  # noqa: BLE001 - caching is a convenience, not required
        print(f"Could not cache session: {e}")
    return api


def pull_snapshot(api, today, prev_snap):
    """Point-in-time metrics. Every value falls back to the previous file."""
    snap = dict(prev_snap)  # preserves goal, targets, and anything we can't refresh
    yday = (today - timedelta(days=1)).isoformat()
    tstr = today.isoformat()

    mm = safe("vo2max", lambda: api.get_max_metrics(tstr))
    vo2 = dig(mm, 0, "generic", "vo2MaxPreciseValue") or dig(mm, 0, "generic", "vo2MaxValue")
    if vo2:
        snap["vo2max"] = round(float(vo2), 1)

    fa = safe("fitnessAge", lambda: api.get_fitnessage_data(tstr))
    if dig(fa, "fitnessAge") or dig(fa, "achievableFitnessAge") or dig(fa, "chronologicalAge"):
        if dig(fa, "fitnessAge") is not None:
            snap["fitnessAge"] = round(float(fa["fitnessAge"]), 1)
        if dig(fa, "achievableFitnessAge") is not None:
            snap["achievableFitnessAge"] = round(float(fa["achievableFitnessAge"]), 1)
        if dig(fa, "chronologicalAge") is not None:
            snap["chronoAge"] = int(fa["chronologicalAge"])

    stats = safe("dailyStats", lambda: api.get_stats(yday), {})
    if dig(stats, "restingHeartRate") is not None:
        snap["rhr"] = int(stats["restingHeartRate"])
    if dig(stats, "averageStressLevel") is not None and stats["averageStressLevel"] >= 0:
        snap["stressLatest"] = int(stats["averageStressLevel"])

    hrv = safe("hrv", lambda: api.get_hrv_data(yday), {})
    if dig(hrv, "hrvSummary", "lastNightAvg") is not None:
        snap["hrv"] = int(hrv["hrvSummary"]["lastNightAvg"])
    if dig(hrv, "hrvSummary", "status"):
        snap["hrvStatus"] = str(hrv["hrvSummary"]["status"]).title()

    ts = safe("trainingStatus", lambda: api.get_training_status(tstr), {})
    latest = dig(ts, "mostRecentTrainingStatus", "latestTrainingStatusData", default={})
    if isinstance(latest, dict) and latest:
        first = next(iter(latest.values()), {})
        if dig(first, "trainingStatusFeedbackPhrase"):
            snap["trainingStatus"] = str(first["trainingStatusFeedbackPhrase"]).replace("_", " ").title()

    tr = safe("readiness", lambda: api.get_training_readiness(tstr))
    if dig(tr, 0, "score") is not None:
        snap["readiness"] = int(tr[0]["score"])
        # readinessLevel is hand-written prose; only replace it if Garmin gives one.
        if dig(tr, 0, "feedbackShort"):
            snap["readinessLevel"] = str(tr[0]["feedbackShort"]).replace("_", " ").capitalize()

    sleep = safe("sleep", lambda: api.get_sleep_data(yday), {})
    score = dig(sleep, "dailySleepDTO", "sleepScores", "overall", "value")
    if score is not None:
        snap["sleepScoreLast"] = int(score)

    bc = safe("weight", lambda: api.get_body_composition(
        (today - timedelta(days=30)).isoformat(), tstr), {})
    weights = [w for w in dig(bc, "dateWeightList", default=[]) if w.get("weight")]
    if weights:
        w = max(weights, key=lambda x: x.get("calendarDate", ""))
        snap["weight"] = round(w["weight"] / 1000 * 2.20462, 1)  # grams -> lb
        snap["weightAsOf"] = w.get("calendarDate", tstr)
        if w.get("bmi") is not None:
            snap["bmi"] = round(float(w["bmi"]), 1)
            snap["bmiAsOf"] = w.get("calendarDate", tstr)

    steps = safe("steps", lambda: api.get_daily_steps(
        (today - timedelta(days=7)).isoformat(), tstr), [])
    walked = [s for s in (steps or []) if s.get("totalSteps")]
    if walked:
        s = max(walked, key=lambda x: x.get("calendarDate", ""))
        snap["steps"] = int(s["totalSteps"])
        snap["stepsAsOf"] = s.get("calendarDate", tstr)
        if s.get("stepGoal"):
            snap["stepGoal"] = int(s["stepGoal"])

    rp = safe("racePredictions", lambda: api.get_race_predictions(), {})
    preds = rp[0] if isinstance(rp, list) and rp else rp
    mapping = {"5K": "time5K", "10K": "time10K", "Half": "timeHalfMarathon",
               "Marathon": "timeMarathon"}
    fresh_preds = {k: hhmmss(dig(preds, v)) for k, v in mapping.items() if dig(preds, v)}
    if fresh_preds:
        snap["racePredictions"] = {**snap.get("racePredictions", {}), **fresh_preds}
        if snap.get("goal") and fresh_preds.get("Marathon"):
            snap["goal"] = {**snap["goal"], "current": fresh_preds["Marathon"]}

    return snap


def pull_trends(api, today, prev_trends):
    """Daily/weekly series via garth's stats endpoints, merged onto history."""
    trends = {k: list(v) for k, v in (prev_trends or {}).items()}
    end = today.isoformat()

    try:
        import garth
    except ImportError:
        notes.append("  ! trends: garth not installed; kept previous series")
        stale.append("trends")
        return trends

    def series(name, cls_name, value_attr, transform=lambda v: v, period=TREND_DAYS):
        cls = getattr(garth, cls_name, None)
        if cls is None:
            warn(f"trends.{name}", AttributeError(f"garth has no {cls_name}"))
            return
        try:
            rows = cls.list(end, period) or []
        except Exception as e:  # noqa: BLE001
            warn(f"trends.{name}", e)
            return
        fresh = []
        for r in rows:
            day = getattr(r, "calendar_date", None)
            val = getattr(r, value_attr, None)
            if day is None or val is None:
                continue
            try:
                fresh.append({"d": mmdd(day.isoformat() if hasattr(day, "isoformat") else day),
                              "v": transform(val)})
            except (TypeError, ValueError):
                continue
        if fresh:
            trends[name] = merge_trend(trends.get(name), fresh)
        else:
            stale.append(f"trends.{name}")

    series("hrv", "DailyHRV", "weekly_avg", lambda v: int(round(v)))
    series("sleepScore", "DailySleep", "value", lambda v: int(round(v)))
    series("stressWeekly", "WeeklyStress", "value", lambda v: int(round(v)),
           period=WEEKLY_WEEKS)

    # VO2max and RHR have no bulk endpoint — append today's point to history.
    return trends


def pull_running(api, today, prev_running):
    """Weekly mileage, YTD totals, and the polarized split carved by time-in-zone."""
    running = dict(prev_running or {})
    start = today - timedelta(days=max(POLARIZED_DAYS, WEEKLY_WEEKS * 7) + 7)
    acts = safe("activities", lambda: api.get_activities_by_date(
        start.isoformat(), today.isoformat(), "running"), [])
    if not acts:
        stale.append("running")
        return running

    runs = []
    for a in acts:
        day = (a.get("startTimeLocal") or "")[:10]
        dist = a.get("distance") or 0
        if not day or not dist:
            continue
        runs.append({"id": a.get("activityId"), "day": day,
                     "mi": dist / METERS_PER_MILE,
                     "sec": a.get("duration") or 0})

    # Weekly bars, Sunday-start.
    buckets = {}
    for r in runs:
        y, m, d = (int(x) for x in r["day"].split("-"))
        ws = week_start(date(y, m, d))
        buckets[ws] = buckets.get(ws, 0) + r["mi"]
    weeks = sorted(buckets)[-WEEKLY_WEEKS:]
    if weeks:
        running["weekly"] = [{"d": w.strftime("%m-%d"), "v": round(buckets[w], 1)} for w in weeks]
        this_week = week_start(today)
        running["thisWeek"] = round(buckets.get(this_week, 0), 1)
        last4 = [buckets[w] for w in weeks if w < this_week][-4:]
        if last4:
            running["avg4"] = round(sum(last4) / len(last4), 1)

    jan1 = date(today.year, 1, 1).isoformat()
    ytd = [r for r in runs if r["day"] >= jan1]
    # get_activities_by_date only covers our window, so YTD needs its own pull.
    ytd_acts = safe("ytd", lambda: api.get_activities_by_date(jan1, today.isoformat(), "running"), None)
    if ytd_acts is not None:
        ytd = [{"mi": (a.get("distance") or 0) / METERS_PER_MILE} for a in ytd_acts
               if a.get("distance")]
    running["ytd"] = round(sum(r["mi"] for r in ytd), 1)
    running["runsYtd"] = len(ytd)

    last7 = sum(r["mi"] for r in runs
                if r["day"] >= (today - timedelta(days=7)).isoformat())
    running["last7"] = round(last7, 1)

    # Polarized split: carve each run by seconds spent in each HR zone, so an
    # interval session registers its hard reps instead of averaging to gray.
    cutoff = (today - timedelta(days=POLARIZED_DAYS)).isoformat()
    easy_s = gray_s = hard_s = 0.0
    easy_mi = gray_mi = hard_mi = 0.0
    carved = 0
    for r in runs:
        if r["day"] < cutoff or not r["id"]:
            continue
        zones = safe(f"zones.{r['id']}", lambda: api.get_activity_hr_in_timezones(r["id"]), [])
        secs = {}
        for z in zones or []:
            n = z.get("zoneNumber")
            s = z.get("secsInZone") or 0
            if n:
                secs[int(n)] = secs.get(int(n), 0) + float(s)
        total = sum(secs.values())
        if not total:
            continue
        carved += 1
        e = secs.get(1, 0) + secs.get(2, 0)
        g = secs.get(3, 0)
        h = secs.get(4, 0) + secs.get(5, 0)
        easy_s += e; gray_s += g; hard_s += h
        easy_mi += r["mi"] * e / total
        gray_mi += r["mi"] * g / total
        hard_mi += r["mi"] * h / total

    total_s = easy_s + gray_s + hard_s
    if total_s:
        running["polarized"] = {
            "window": f"last {POLARIZED_DAYS} days",
            "method": "time-in-zone",
            "easyPct": round(easy_s / total_s * 100),
            "grayPct": round(gray_s / total_s * 100),
            "hardPct": round(hard_s / total_s * 100),
            "easyMi": round(easy_mi, 1),
            "grayMi": round(gray_mi, 1),
            "hardMi": round(hard_mi, 1),
            "easyMin": round(easy_s / 60),
            "grayMin": round(gray_s / 60),
            "hardMin": round(hard_s / 60),
        }
        print(f"Polarized split carved from {carved} runs (Z2/Z3 boundary {Z3_FLOOR} bpm).")
    else:
        stale.append("running.polarized")

    return running


def main():
    if not os.path.exists(OUT_PATH):
        sys.exit(f"{OUT_PATH} not found — this script updates the existing file, "
                 "it doesn't create one from scratch.")
    with open(OUT_PATH) as f:
        prev = json.load(f)

    api = login()
    today = date.today()

    out = dict(prev)
    out["generated"] = today.isoformat()
    out["snapshot"] = pull_snapshot(api, today, prev.get("snapshot", {}))
    out["trends"] = pull_trends(api, today, prev.get("trends", {}))
    out["running"] = pull_running(api, today, prev.get("running", {}))

    # Append today's point-in-time values to the series with no bulk endpoint.
    snap = out["snapshot"]
    for key, val in (("vo2max", snap.get("vo2max")), ("rhr", snap.get("rhr"))):
        if val is not None:
            out["trends"][key] = merge_trend(out["trends"].get(key),
                                             [{"d": mmdd(today.isoformat()), "v": val}])

    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")

    print(f"\nWrote {OUT_PATH} (generated {out['generated']}).")
    if notes:
        print("Problems:")
        for n in notes:
            print(n)
    if stale:
        print("\nNOT refreshed — these kept their previous values, check before trusting:")
        for s in sorted(set(stale)):
            print(f"  - {s}")
    print("\nStill hand-written, review them yourself: recommendations.continue, "
          "recommendations.change, snapshot.goal, snapshot.vigorousDays, "
          "snapshot.sleepAvg, snapshot.acwr.")
    print("Then: bump the CACHE version in sw.js so phones pull the update.")


if __name__ == "__main__":
    main()
