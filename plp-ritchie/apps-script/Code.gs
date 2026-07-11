/**
 * PLP Ritchie Scheduling — Google Apps Script backend.
 *
 * What it does:
 *  - doPost: receives a form submission (one or more date blocks with a
 *    headcount and names), appends one row per block to the "Submissions"
 *    sheet, and emails NOTIFY_EMAIL. If the submission puts any day over
 *    CAPACITY people, a second, dedicated over-capacity alert email is sent.
 *  - doPost with action "delete": removes one date block by id (honor
 *    system) and emails NOTIFY_EMAIL about the removal.
 *  - doGet: returns all submissions (every season) as JSON. The site uses
 *    this to draw the live calendar and the archived past-season calendars.
 *
 * Season logic (must match index.html):
 *  - The active season is the next summer as of September 1: Sept–Dec of
 *    year Y => season Y+1, Jan–Aug => season Y. Never earlier than 2027.
 *  - The window starts July 1 and runs 6 weeks (42 days). If July 1 through
 *    Labor Day inclusive exceeds 9 exact weeks (63 days), the window is
 *    extended by half the excess, rounded down.
 *
 * One-time setup (see plp-ritchie/SETUP.md for the full walkthrough):
 *  1. Create a Google Sheet, then Extensions -> Apps Script.
 *  2. Replace the default code with this file and save.
 *  3. Deploy -> New deployment -> Web app.
 *     Execute as: Me. Who has access: Anyone.
 *  4. Copy the web app URL into plp-ritchie/config.js.
 */

var NOTIFY_EMAIL = "ritchie3237@gmail.com";
var SITE_URL = "https://ritchie3237.github.io/fuel/plp-ritchie/";
var SHEET_NAME = "Submissions";
var CAPACITY = 12; // days with MORE than this many people get flagged
var FIRST_SEASON = 2027;

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var d = JSON.parse(e.postData.contents);
    if (d._honey) return jsonOut({ ok: true }); // silently drop spam bots

    if (d.action === "delete") return deleteBlock(d);

    if (!d.name) return jsonOut({ ok: false, error: "Missing name" });
    if (!d.email) return jsonOut({ ok: false, error: "Missing email" });
    if (!(d.blocks && d.blocks.length)) {
      return jsonOut({ ok: false, error: "Missing date blocks" });
    }

    var season = activeSeason(new Date());
    var w = seasonWindow(season);
    var minIso = iso(w.start), maxIso = iso(w.end);

    for (var j = 0; j < d.blocks.length; j++) {
      var b = d.blocks[j];
      if (!b.start_date || !b.end_date || !b.people) {
        return jsonOut({ ok: false, error: "Incomplete date block " + (j + 1) });
      }
      if (b.end_date < b.start_date) {
        return jsonOut({ ok: false, error: "Date block " + (j + 1) + ": end before start" });
      }
      if (b.start_date < minIso || b.end_date > maxIso) {
        return jsonOut({ ok: false, error: "Date block " + (j + 1) + " falls outside the summer " +
          season + " window (" + minIso + " to " + maxIso + ")" });
      }
      var n = parseInt(b.people, 10);
      if (!(n >= 1 && n <= 40)) {
        return jsonOut({ ok: false, error: "Date block " + (j + 1) + ": people must be 1-40" });
      }
    }

    var sheet = getSheet();
    var ts = new Date();
    var blockLines = [];

    d.blocks.forEach(function (b) {
      sheet.appendRow([Utilities.getUuid(), ts, d.name, d.email, season,
        b.start_date, b.end_date, parseInt(b.people, 10), b.names || "", d.comments || ""]);
      blockLines.push("<li><b>" + esc(b.start_date) + " to " + esc(b.end_date) + "</b> — " +
        esc(b.people) + " " + (+b.people === 1 ? "person" : "people") +
        (b.names ? " (" + esc(b.names) + ")" : "") + "</li>");
    });

    // Recompute daily totals now that the new rows are in, and flag any
    // over-capacity day this submission touches.
    var all = getSubmissions(sheet).filter(function (s) { return +s.season === season; });
    var totals = dailyTotals(all, w);
    var overDays = [];
    Object.keys(totals).sort().forEach(function (day) {
      if (totals[day] > CAPACITY && d.blocks.some(function (b) {
        return b.start_date <= day && day <= b.end_date;
      })) {
        overDays.push(day + " — " + totals[day] + " people");
      }
    });

    var subject = "PLP Ritchie submission: " + d.name + " — summer " + season +
      " (" + d.blocks.length + " date block" + (d.blocks.length > 1 ? "s" : "") + ")";
    var body =
      '<h3 style="margin:0 0 10px">New PLP Ritchie date submission</h3>' +
      '<table cellpadding="6" style="border-collapse:collapse;border:1px solid #ccc">' +
      row("Name", d.name) + row("Email", d.email) + row("Season", "Summer " + season) +
      row("Comments", d.comments || "—") +
      "</table>" +
      "<h4>Date block" + (d.blocks.length > 1 ? "s" : "") + "</h4>" +
      "<ul>" + blockLines.join("") + "</ul>" +
      '<p><a href="' + SITE_URL + '">View the calendar</a></p>';
    MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, htmlBody: body });

    if (overDays.length) {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: "⚠ PLP Ritchie OVER CAPACITY: " + overDays.length + " day" +
          (overDays.length > 1 ? "s" : "") + " above " + CAPACITY + " people",
        htmlBody:
          '<h3 style="margin:0 0 10px;color:#8c2f2f">Over-capacity days after ' +
          esc(d.name) + "'s submission</h3>" +
          "<p>These summer " + season + " days now have more than " + CAPACITY +
          " people at once:</p>" +
          "<ul><li>" + overDays.map(esc).join("</li><li>") + "</li></ul>" +
          '<p><a href="' + SITE_URL + '">View the calendar</a></p>'
      });
    }

    return jsonOut({ ok: true, over_capacity_days: overDays.length });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** Removes one date block by id and notifies NOTIFY_EMAIL. */
function deleteBlock(d) {
  if (!d.id) return jsonOut({ ok: false, error: "Missing id" });
  var sheet = getSheet();
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(d.id)) {
      var v = values[i];
      // Only the active season's entries can be removed; archives are read-only.
      if (+v[4] !== activeSeason(new Date())) {
        return jsonOut({ ok: false, error: "Archived seasons can't be changed" });
      }
      sheet.deleteRow(i + 1);
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: "PLP Ritchie: " + v[2] + " removed dates (" + fmtDate(v[5]) +
          " to " + fmtDate(v[6]) + ")",
        htmlBody: "<p><b>" + esc(v[2]) + "</b> removed a date block from summer " + v[4] +
          ": " + esc(fmtDate(v[5])) + " to " + esc(fmtDate(v[6])) + ", " + esc(v[7]) +
          " people" + (v[8] ? " (" + esc(v[8]) + ")" : "") + ".</p>" +
          '<p><a href="' + SITE_URL + '">View the calendar</a></p>'
      });
      return jsonOut({ ok: true });
    }
  }
  return jsonOut({ ok: false, error: "Entry not found (maybe already removed)" });
}

function doGet() {
  try {
    return jsonOut({
      ok: true,
      active_season: activeSeason(new Date()),
      capacity: CAPACITY,
      submissions: getSubmissions(getSheet())
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// ----- Season math (keep identical to index.html) -----

// Sept-Dec of year Y => season Y+1; Jan-Aug => season Y; never before 2027.
function activeSeason(now) {
  var s = now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear();
  return Math.max(s, FIRST_SEASON);
}

// Labor Day = first Monday of September.
function laborDay(year) {
  var d = new Date(year, 8, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d;
}

// July 1 + 6 weeks, extended by half of however much July 1 through Labor
// Day (inclusive) exceeds 9 exact weeks (63 days), rounded down.
function seasonWindow(year) {
  var start = new Date(year, 6, 1);
  var inclusiveDays = Math.round((laborDay(year) - start) / 86400000) + 1;
  var ext = Math.max(0, Math.floor((inclusiveDays - 63) / 2));
  return { start: start, end: new Date(year, 6, 1 + 41 + ext) };
}

function dailyTotals(subs, w) {
  var totals = {};
  for (var d = new Date(w.start); d <= w.end; d.setDate(d.getDate() + 1)) {
    var day = iso(d);
    var sum = 0;
    subs.forEach(function (s) {
      if (s.start_date <= day && day <= s.end_date) sum += +s.people || 0;
    });
    totals[day] = sum;
  }
  return totals;
}

// ----- Sheet helpers -----

function getSheet() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(["ID", "Submitted", "Name", "Email", "Season",
      "Start date", "End date", "People", "Names", "Comments"]);
  }
  return sh;
}

function getSubmissions(sheet) {
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    if (!v[2] || String(v[0]) === "ID") continue; // skip blanks and stray header rows
    out.push({
      id: String(v[0]),
      submitted: v[1] instanceof Date ? v[1].toISOString() : String(v[1]),
      name: String(v[2]),
      email: String(v[3]),
      season: String(v[4]),
      start_date: fmtDate(v[5]),
      end_date: fmtDate(v[6]),
      people: +v[7] || 0,
      names: String(v[8] || ""),
      comments: String(v[9] || "")
    });
  }
  return out;
}

function iso(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// Sheets auto-parses "2027-07-03" into a Date; normalize back to ISO.
function fmtDate(v) {
  if (v instanceof Date) return iso(v);
  return String(v);
}

function row(k, v) {
  return '<tr><td style="border:1px solid #ccc;background:#f4f4f4"><strong>' + esc(k) +
    '</strong></td><td style="border:1px solid #ccc">' + esc(v) + "</td></tr>";
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function jsonOut(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
