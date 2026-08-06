/**
 * PLP McGee Scheduling — Google Apps Script backend.
 *
 * What it does:
 *  - doPost: receives a form submission (one or more date requests), appends
 *    one row per date range to the "Submissions" sheet, and emails
 *    NOTIFY_EMAIL — flagging any date overlaps with existing requests right
 *    in the email.
 *  - doGet: returns all submissions as JSON for the review page.
 *
 * One-time setup (see plp/SETUP.md for the full walkthrough):
 *  1. Create a Google Sheet, then Extensions -> Apps Script.
 *  2. Replace the default code with this file and save.
 *  3. Deploy -> New deployment -> Web app.
 *     Execute as: Me. Who has access: Anyone.
 *  4. Copy the web app URL into plp/config.js.
 */

var NOTIFY_EMAIL = "ritchie3237@gmail.com";
var GROUP_EMAIL = "plpcamp@googlegroups.com";
var FORM_URL = "https://ritchie3237.github.io/fuel/plp/";
var REVIEW_URL = "https://ritchie3237.github.io/fuel/plp/review.html";
var SHEET_NAME = "Submissions";
var SCHEDULE_CALENDAR = "PLP Off-Season Schedule";

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var d = JSON.parse(e.postData.contents);
    if (d._honey) return jsonOut({ ok: true }); // silently drop spam bots

    if (d.action === "publish_schedule") return publishSchedule(d);

    var required = ["name", "email", "season"];
    for (var i = 0; i < required.length; i++) {
      if (!d[required[i]]) return jsonOut({ ok: false, error: "Missing " + required[i] });
    }
    if (!(d.requests && d.requests.length)) {
      return jsonOut({ ok: false, error: "Missing date requests" });
    }
    for (var j = 0; j < d.requests.length; j++) {
      var r = d.requests[j];
      if (!r.start_date || !r.end_date || !r.type || !r.exclusive) {
        return jsonOut({ ok: false, error: "Incomplete date request " + (j + 1) });
      }
      if (r.exclusive === "No" && !r.people) {
        return jsonOut({ ok: false, error: "Missing people count for date request " + (j + 1) });
      }
    }

    var sheet = getSheet();
    var existing = getSubmissions(sheet);
    var ts = new Date();
    var totalOverlaps = 0;
    var anyExclusive = false;
    var reqLines = [];

    d.requests.forEach(function (r) {
      var overlaps = existing.filter(function (o) {
        return o.start_date <= r.end_date && r.start_date <= o.end_date;
      });
      totalOverlaps += overlaps.length;
      var people = r.exclusive === "No" ? String(r.people) : "";
      if (r.exclusive === "Yes") anyExclusive = true;

      sheet.appendRow([ts, d.name, d.email, d.season, r.start_date, r.end_date,
        r.type, r.exclusive, people, d.comments || ""]);

      var line = "<li><b>" + esc(r.start_date) + " to " + esc(r.end_date) + "</b> (" +
        esc(r.type) +
        (r.exclusive === "Yes" ? ", exclusive" : ", sharing OK · " + esc(people) + " people") + ")";
      if (overlaps.length) {
        line += '<ul style="color:#8c2f2f">';
        overlaps.forEach(function (o) {
          line += "<li>⚠ overlaps " + esc(o.name) + " — " + esc(o.start_date) + " to " +
            esc(o.end_date) + (o.type === "Backup" ? " (backup)" : "") + "</li>";
        });
        line += "</ul>";
      }
      line += "</li>";
      reqLines.push(line);
    });

    var subject = "PLP Request: " + d.name + " — " + d.season +
      " (" + d.requests.length + " date option" + (d.requests.length > 1 ? "s" : "") + ")" +
      (anyExclusive ? " [EXCLUSIVE]" : "") +
      (totalOverlaps ? " ⚠ OVERLAPS " + totalOverlaps + " request" + (totalOverlaps > 1 ? "s" : "") : "");

    var body =
      '<h3 style="margin:0 0 10px">New PLP date request</h3>' +
      '<table cellpadding="6" style="border-collapse:collapse;border:1px solid #ccc">' +
      row("Name", d.name) + row("Email", d.email) + row("Season", d.season) +
      row("Comments", d.comments || "—") +
      "</table>" +
      "<h4>Date request" + (d.requests.length > 1 ? "s" : "") + "</h4>" +
      "<ul>" + reqLines.join("") + "</ul>" +
      (totalOverlaps ? "" : "<p>No overlaps with existing requests.</p>") +
      '<p><a href="' + REVIEW_URL + '">Review all requests</a></p>';

    MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, htmlBody: body });
    sendConfirmation(d);
    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Group announcement mailer. Run setupTriggers() ONCE from the editor to
 * install a daily noon check; on the first Monday of January/May it emails
 * the family group that submissions are open, and on the fourth Monday
 * (exactly 3 weeks later) that one week remains.
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "dailyGroupMailer") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("dailyGroupMailer").timeBased().everyDays(1).atHour(12).create();
}

function dailyGroupMailer() {
  var today = new Date();
  if (today.getDay() !== 1) return; // Mondays only
  var m = today.getMonth();
  var nth = Math.floor((today.getDate() - 1) / 7) + 1; // which Monday of the month
  if (m === 0 && nth === 1) announceOpen("Spring");
  if (m === 4 && nth === 1) announceOpen("Fall");
  if (m === 0 && nth === 4) announceOneWeekLeft("Spring");
  if (m === 4 && nth === 4) announceOneWeekLeft("Fall");
}

function announceOpen(season) {
  var windowText = season === "Spring" ? "May and June" : "the day after Labor Day through October";
  var seasonLabel = season === "Spring" ? "Spring (May & June)" : "Fall (Sept & Oct)";
  var deadline = Utilities.formatDate(addDays(new Date(), 28), Session.getScriptTimeZone(), "EEEE, MMMM d");
  var body =
    "<p><b>" + season + " off-season requests are now open for the Pocono Lake Preserve house!</b></p>" +
    "<p>The " + season.toLowerCase() + " off-season covers <b>" + windowText + "</b>.</p>" +
    '<p>👉 <b>Submit your date requests here: <a href="' + FORM_URL + '">' + FORM_URL + "</a></b></p>" +
    "<p>Fill in your name, email, and your date request(s) — you can add multiple options and mark " +
    "each Primary or Backup, say whether you'd want the house exclusively to yourselves, and add comments.</p>" +
    "<p>⏳ <b>Submissions are due in 4 weeks — by " + deadline + ".</b> After the window closes, all " +
    "requests are reviewed together, conflicts get sorted out (backups help!), and the final schedule " +
    "is published to the shared PLP Off-Season Schedule calendar.</p>";
  MailApp.sendEmail({ to: GROUP_EMAIL,
    subject: "PLP Off-Season Scheduling OPEN — " + seasonLabel, htmlBody: body });
}

function announceOneWeekLeft(season) {
  var seasonLabel = season === "Spring" ? "spring (May & June)" : "fall (after Labor Day – October)";
  var deadline = Utilities.formatDate(addDays(new Date(), 7), Session.getScriptTimeZone(), "EEEE, MMMM d");
  var body =
    "<p><b>Only 1 week remains to submit your " + seasonLabel + " date requests for the Pocono Lake " +
    "Preserve house!</b></p>" +
    "<p>The window closes on <b>" + deadline + "</b>. If you haven't put in your dates yet:</p>" +
    '<p>👉 <b>Submit now: <a href="' + FORM_URL + '">' + FORM_URL + "</a></b></p>" +
    "<p>Include backup options if your dates are flexible — it makes the schedule work better for everyone.</p>";
  MailApp.sendEmail({ to: GROUP_EMAIL,
    subject: "PLP " + season + " Submissions — 1 WEEK LEFT", htmlBody: body });
}

// Receipt to the submitter. Failures here (e.g. a typo'd address) must not
// break the submission, which is already stored and reported.
function sendConfirmation(d) {
  try {
    var lines = d.requests.map(function (r) {
      return "<li><b>" + esc(r.start_date) + " to " + esc(r.end_date) + "</b> (" + esc(r.type) +
        (r.exclusive === "Yes" ? ", exclusive use" : ", open to sharing" +
          (r.people ? " · " + esc(r.people) + " people" : "")) + ")</li>";
    }).join("");
    var body =
      "<p>Hi " + esc(d.name) + ",</p>" +
      "<p>Your date request" + (d.requests.length > 1 ? "s for" : " for") + " the Pocono Lake Preserve house " +
      (d.requests.length > 1 ? "were" : "was") + " received for <b>" + esc(d.season) + "</b>:</p>" +
      "<ul>" + lines + "</ul>" +
      (d.comments ? "<p>Your comments: " + esc(d.comments) + "</p>" : "") +
      "<p><b>What happens next:</b> once the submission window closes, all requests are reviewed " +
      "together, any conflicts get sorted out (backup options help!), and the final schedule is " +
      "published to the shared <b>PLP Off-Season Schedule</b> Google Calendar.</p>" +
      "<p>Need to change something? Just reply to this email or submit an updated request at " +
      '<a href="https://ritchie3237.github.io/fuel/plp/">the scheduling page</a>.</p>';
    MailApp.sendEmail({
      to: d.email,
      subject: "PLP request received — " + d.season,
      htmlBody: body
    });
  } catch (err) {
    // Swallow: submitter typo'd their email or quota hit; the request itself is safe.
  }
}

/**
 * Publishes a finalized season schedule to the "PLP Off-Season Schedule"
 * Google Calendar (created on first use). Existing PLP events inside that
 * season's window are replaced, so republishing is safe.
 */
function publishSchedule(d) {
  if (!d.season) return jsonOut({ ok: false, error: "Missing season" });
  if (!(d.stays && d.stays.length)) return jsonOut({ ok: false, error: "No stays to publish" });
  var w = seasonWindowFromLabel(d.season);
  if (!w) return jsonOut({ ok: false, error: "Unrecognized season: " + d.season });

  var cal = getScheduleCalendar();
  var cleared = 0;
  cal.getEvents(w.min, addDays(w.max, 1)).forEach(function (ev) {
    if (ev.getTitle().indexOf("PLP ") === 0) { ev.deleteEvent(); cleared++; }
  });

  var created = 0;
  d.stays.forEach(function (s) {
    if (!s.name || !s.start_date || !s.end_date) return;
    var title = (s.exclusive === "Yes" ? "PLP Exclusive - " : "PLP Non-Exclusive - ") + s.name;
    var desc = "Published from PLP McGee Scheduling — " + d.season +
      (s.exclusive === "No" && s.people ? " · " + s.people + " people" : "");
    // All-day events use an exclusive end date, so add one day.
    cal.createAllDayEvent(title, parseDay(s.start_date), addDays(parseDay(s.end_date), 1),
      { description: desc });
    created++;
  });

  return jsonOut({ ok: true, calendar: SCHEDULE_CALENDAR, cleared: cleared, created: created });
}

function getScheduleCalendar() {
  var cals = CalendarApp.getCalendarsByName(SCHEDULE_CALENDAR);
  return cals.length ? cals[0] : CalendarApp.createCalendar(SCHEDULE_CALENDAR);
}

function parseDay(s) {
  var p = String(s).split("-");
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function seasonWindowFromLabel(label) {
  var m = /^(Spring|Fall)\s+(\d{4})$/.exec(String(label));
  if (!m) return null;
  var y = +m[2];
  if (m[1] === "Spring") return { min: new Date(y, 4, 1), max: new Date(y, 5, 30) };
  var ld = new Date(y, 8, 1);
  while (ld.getDay() !== 1) ld.setDate(ld.getDate() + 1);
  return { min: new Date(y, 8, ld.getDate() + 1), max: new Date(y, 9, 31) };
}

function doGet() {
  try {
    return jsonOut({ ok: true, submissions: getSubmissions(getSheet()) });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function getSheet() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(["Submitted", "Name", "Email", "Season", "Start date", "End date",
      "Type", "Exclusive", "People", "Comments"]);
  }
  return sh;
}

function getSubmissions(sheet) {
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var v = values[i];
    if (!v[1]) continue;
    out.push({
      submitted: v[0] instanceof Date ? v[0].toISOString() : String(v[0]),
      name: String(v[1]),
      email: String(v[2]),
      season: String(v[3]),
      start_date: fmtDate(v[4]),
      end_date: fmtDate(v[5]),
      type: String(v[6] || "Primary"),
      exclusive: String(v[7] || ""),
      people: String(v[8] || ""),
      comments: String(v[9] || "")
    });
  }
  return out;
}

// Sheets auto-parses "2026-09-08" into a Date; normalize back to ISO.
function fmtDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
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
