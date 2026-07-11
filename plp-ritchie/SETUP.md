# PLP Ritchie Scheduling — one-time backend setup (~5 minutes)

Submissions are stored in a Google Sheet in your account and emailed to you
by a small Google Apps Script — the same pattern as the McGee scheduler, but
with its own sheet and its own script deployment. Google only lets the
account owner deploy the script, so these steps are yours; everything else
is already wired up.

## Steps

1. **Create the spreadsheet.** Go to [sheets.google.com](https://sheets.google.com)
   (signed in as ritchie3237@gmail.com), create a blank spreadsheet, and name it
   something like `PLP Ritchie Scheduling`.

2. **Open the script editor.** In the sheet: **Extensions → Apps Script**.

3. **Paste the code.** Delete the placeholder in the editor and paste the full
   contents of [`apps-script/Code.gs`](apps-script/Code.gs). Save (Ctrl/Cmd+S).

4. **Deploy it.** Click **Deploy → New deployment**, click the gear icon and
   choose **Web app**, then set:
   - Description: anything (e.g. `v1`)
   - **Execute as: Me**
   - **Who has access: Anyone**

   Click **Deploy**. Google will ask you to authorize the script (it needs
   permission to edit your sheet and send email as you) — click through
   **Advanced → Go to (project name)** if it warns the app is unverified;
   that warning appears because you wrote the script yourself.

5. **Copy the Web app URL.** It looks like
   `https://script.google.com/macros/s/AKfycb.../exec`.

6. **Paste it into `config.js`.** Edit [`config.js`](config.js) in this folder
   (easiest: edit the file directly on GitHub) and replace the placeholder URL
   with yours. Or just send the URL to Claude and it'll do this step.

That's it. From then on:

- Every submission appears as rows in the sheet and lands in your inbox.
- If a submission pushes any day past 12 people, you get a second,
  clearly-marked **over-capacity alert** email, and the day turns red on
  the site's calendar.
- Removals (people deleting their own entry) also email you.
- Every September 1 the site automatically rolls over to the next summer,
  and the finished season shows up under "Past summers" on the page —
  no maintenance needed.

## If you ever update the script

Changes to Code.gs only go live after **Deploy → Manage deployments →
(pencil) → Version: New version → Deploy**. The URL stays the same.

## Privacy note

The web app URL is long and unguessable, but anyone who has it can submit
dates and view the submission list (names, emails, dates), and removals are
honor-system. That's the trade-off for keeping this free and login-free —
fine for family scheduling, so just share the link with people you'd share
the calendar with.
