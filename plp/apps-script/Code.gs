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
var REVIEW_URL = "https://ritchie3237.github.io/fuel/plp/review.html";
var SHEET_NAME = "Submissions";

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var d = JSON.parse(e.postData.contents);
    if (d._honey) return jsonOut({ ok: true }); // silently drop spam bots

    var required = ["name", "email", "season", "exclusive"];
    for (var i = 0; i < required.length; i++) {
      if (!d[required[i]]) return jsonOut({ ok: false, error: "Missing " + required[i] });
    }
    if (!(d.requests && d.requests.length)) {
      return jsonOut({ ok: false, error: "Missing date requests" });
    }
    for (var j = 0; j < d.requests.length; j++) {
      var r = d.requests[j];
      if (!r.start_date || !r.end_date || !r.type) {
        return jsonOut({ ok: false, error: "Incomplete date request " + (j + 1) });
      }
    }
    if (d.exclusive === "No" && !d.people) {
      return jsonOut({ ok: false, error: "Missing people count" });
    }

    var sheet = getSheet();
    var existing = getSubmissions(sheet);
    var ts = new Date();
    var people = d.exclusive === "No" ? String(d.people) : "";
    var totalOverlaps = 0;
    var reqLines = [];

    d.requests.forEach(function (r) {
      var overlaps = existing.filter(function (o) {
        return o.start_date <= r.end_date && r.start_date <= o.end_date;
      });
      totalOverlaps += overlaps.length;

      sheet.appendRow([ts, d.name, d.email, d.season, r.start_date, r.end_date,
        r.type, d.exclusive, people, d.comments || ""]);

      var line = "<li><b>" + esc(r.start_date) + " to " + esc(r.end_date) + "</b> (" +
        esc(r.type) + ")";
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
      (d.exclusive === "Yes" ? " [EXCLUSIVE]" : "") +
      (totalOverlaps ? " ⚠ OVERLAPS " + totalOverlaps + " request" + (totalOverlaps > 1 ? "s" : "") : "");

    var body =
      '<h3 style="margin:0 0 10px">New PLP date request</h3>' +
      '<table cellpadding="6" style="border-collapse:collapse;border:1px solid #ccc">' +
      row("Name", d.name) + row("Email", d.email) + row("Season", d.season) +
      row("Exclusive use", d.exclusive) +
      (d.exclusive === "No" ? row("How many people", people) : "") +
      row("Comments", d.comments || "—") +
      "</table>" +
      "<h4>Date request" + (d.requests.length > 1 ? "s" : "") + "</h4>" +
      "<ul>" + reqLines.join("") + "</ul>" +
      (totalOverlaps ? "" : "<p>No overlaps with existing requests.</p>") +
      '<p><a href="' + REVIEW_URL + '">Review all requests</a></p>';

    MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, htmlBody: body });
    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
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
