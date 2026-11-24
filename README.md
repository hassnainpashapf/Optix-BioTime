# ZKT

Attendance, shifts, leave, overtime and payroll for ZKTeco-type biometric devices. Node 24+ (uses built-in SQLite), no build step.

## Run
```
npm install
npm start            # http://localhost:8080  login: admin / admin123 (change it in Settings)
```
Environment: `PORT`, `ADMIN_PASSWORD` (first start only), `DB_FILE` (default `biotime.db`), `BACKUP_DIR`, `LOG_DIR`.

## Test without a device
```
npm test             # report/payroll rules
npm run e2e          # real server + fake device: push, approve, reports, payroll, backup
node sim-device.js http://localhost:8080 SIM0001 10   # feed a running server with fake punches
```

## Connect a real device (push mode, recommended)
1. Start the server on a PC the device can reach (same LAN). Note its IP and allow port 8080 in the firewall.
2. On the device: Menu > Comm. > Cloud Server Setting (also called ADMS / Web Server). Server Address = the PC's IP, Port = 8080, HTTPS off.
3. Within a minute the device appears on the **Devices** page as unapproved. Press **Approve**.
4. It uploads its users and punch history. Create a shift (Shifts), assign it to employees (Employees), then open Reports.

Pull mode (device IP, port 4370, "Sync now") and CSV import are fallbacks.

## If the real device does not behave
Every request a device makes is recorded in `logs/adms.log`. Send that file's tail (and the device model) and the protocol handling in `adms.js` can be adjusted. The push protocol was written from the ZKTeco iclock/ADMS format and tested against the simulator only; firmware differences are the main risk.

## Rules (Settings page)
- Day-shift punches belong to their calendar day. A shift whose end is earlier than its start (22:00-06:00) is overnight and belongs to the day it started.
- First punch = in, last punch = out. One punch = "Missing Out" (counts as present, flagged).
- Late = in later than shift start + grace. Optional: late beyond N minutes = absent, N lates = 1 day deducted, short day = half day.
- Overtime: after shift end on work days; whole worked time on weekly off and holidays. Below the minimum it is ignored, then rounded down.
- Days before an employee's join date (or first ever punch if no join date) are never counted absent.
- Payroll: day rate = salary / working days in the month. Deduct absent, half day (0.5), unpaid leave. Overtime pay = day rate / shift hours x multiplier.

## Data safety
Automatic daily copy in `backups/` (last 14), plus Settings > Download backup. Login is rate limited and tokens expire after 12 h. The device endpoints (`/iclock/*`) cannot use a login, so unknown devices are held until approved; keep the server on your LAN, not the open internet.

## Roster, manual punches, users
- **Roster**: give an employee a different shift for a date range (night duty, temporary change).
- **Attendance > Add manual punch**: fixes a forgotten scan. Manual punches are marked and can be deleted; device punches cannot.
- **Settings > Users**: add a read-only *viewer* (e.g. a manager who only looks at reports) or another admin.

## Keep it running after reboot
- macOS: `mkdir -p logs && cp deploy/com.attendance.manager.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.attendance.manager.plist` (stop: `launchctl unload ...`). A LaunchAgent runs while you are logged in; use a always-on machine for the server.
- Linux: `deploy/attendance.service` (systemd).

## Not included
Door access control, visitor management and meetings are separate products that need real door/controller hardware and a different data model. Device-side user/fingerprint editing (writing users back to the device) is not implemented; manage users on the device.

## Reports, exports, permissions, restore
- **Reports**: 15 report types (daily, summary, late, early, absent, missing punch, working hours, transactions, shift, department, employee, leave, overtime, payroll, custom). Every one filters by date, department, branch, designation, group and employee, and exports to CSV, Excel (.xlsx) and PDF. A custom report lets you choose the columns and statuses and can be saved. **Statistics** and **Calendar** pages show the same data as charts and a month grid.
- **Roles**: `admin` is fixed. `hr`, `manager` and `viewer` are starting points; create your own in Settings > Access and set none/view/edit per area. Changes apply on the user's next click.
- **Data access**: a user can be limited to departments, branches or companies. Such a login sees only those employees everywhere (lists, reports, payroll, notifications, exports) and cannot change company-wide settings.
- **Admin only, always**: users, roles, audit log, backup, restore.
- **Restore**: Settings > Data > Restore. The file is checked, the server stops, and on the next start the backup replaces the database (the old one is kept as `.before-restore-...`). Run the server as a service (`deploy/`) so it comes back by itself, otherwise start it again by hand.
- PDF text uses a Latin character set: names in other scripts (for example Urdu) show as `?` in PDF but are fine in CSV and Excel.

## Tests
`npm test` (rules) and `npm run e2e` (8 end-to-end suites against a real server with a throwaway database).

## Shifts
- **Types**: fixed hours; *flexible* (work N hours anywhere in a window: no lateness, short days are flagged "Short Hours", extra hours are overtime); *split* (two parts per day, the gap is not paid).
- **Unpaid break** window per shift: subtracted from worked time only when the employee was present during it.
- **Alternate weekly off** such as `6:2,4` (Saturday off on the 2nd and 4th Saturday).
- **Shift-level rules**: a shift can have its own "late = absent after", "half day below" and overtime policy; blank means use Settings.
- **Which shift applies each day** (first match wins): roster entry, rotation, the employee's own shift (or, if they are allowed several, the one starting closest to when they arrived), the department's default shift.
- **Rotations** repeat a pattern of shifts and days off from a start date; rotation days ignore the normal work-day settings.
- **Change and swap requests** go through approval and are written to the roster. **Suggest shifts** looks at real punches for people with no shift. The **Shift calendar** shows the month for everyone and exports to Excel and PDF.

## Employee portal (phones)
Employees open **/portal** on their phone: check in and out with GPS, see their attendance, apply for leave, send missed-punch / on-duty / shift change and swap requests, read announcements and notifications, and see payslips once HR finalizes a month. A reporting manager also sees a **My team** screen to approve their team's requests.
1. **Accounts**: Portal accounts page > "Create accounts for everyone without one". Passwords are shown once (download the CSV); employees must choose their own at first sign-in. Sign-in uses the employee ID. Five wrong passwords lock the account for 15 minutes.
2. **Locations**: add the office with its latitude and longitude (press "Use my current position" while standing there) and a radius. A location can be open to everyone, tied to a branch, or assigned to certain people. In Settings, "Phone punch location" picks the rule: 2 = must be inside (default), 1 = accept anywhere but mark for review, 0 = only record the position.
3. **Who approves**: set "Reports to" on each employee's profile.
4. **https is required for GPS.** Phones only share their location on an https page. Either run `npm run cert` once (self-signed; phones show a warning the first time) and start with `TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start` (portal on https://SERVER-IP:8443/portal), or put the server behind a reverse proxy that has a real certificate. Attendance devices keep using plain http on port 8080.
5. Review phone punches on the **Mobile punches** page; remove ones you do not trust.
- Limits to know: a determined person can fake GPS on a rooted or modified phone. The system records the position, accuracy and phone, flags unusual punches and keeps an audit trail, but it cannot prove a person is physically there. Punch time always comes from the server clock.

## Devices
- **Health**: every device shows Online / Offline. A push device is offline when it has not contacted the server for the number of minutes set in Settings; a pull device is checked by trying its port every minute. Going offline and coming back are recorded as events and appear in the notification bell.
- **Registry**: name, location, group, serial number or IP/port, check-in interval, retry interval, real-time upload. Typing a serial number yourself trusts that device from its first connection; an unknown device that connects on its own waits for approval and anything it sends is ignored until then.
- **Groups**: a group tied to a branch means its devices receive only that branch's employees.
- **Commands** (push devices): send all employees, fetch users, set the clock, restart, ask for punches of certain days again. They wait in a queue the device collects every few seconds; each shows done / failed, can be cancelled before it is collected, and a failed one can be retried. Anything unanswered for 15 minutes is marked failed.
- **Cards**: the card number is part of the employee profile, is sent to devices with the person, and a card enrolled on a device is adopted unless it already belongs to someone else (recorded as an event).
- **Fingerprints and faces** are enrolled on the device. The system always counts them per employee. It keeps the templates themselves **only if you switch on "Keep fingerprint/face templates"** in Settings (off by default, because they are biometric personal data). Stored templates are encrypted with a key kept in a separate file next to the database (`.biokey`, or set `BIO_KEY`); keep that file with your backups or restored templates cannot be read. Templates never appear in the API, the logs or the command queue, and Settings can erase them all.
- **Not yet verified on real hardware**: the command formats follow the ZKTeco push protocol and were exercised against the built-in simulator (`SimDevice` in `sim-device.js`), not a physical device. Try one device first and read the command queue; a command the device does not understand shows as failed. The clock command and the re-send-punches command are the ones most likely to need adjusting for your model. Pull devices cannot be restarted or have their clock set because the library used does not offer it.

## Connecting other software (Integrations)
- **API keys** (Integrations page, admin only): give each outside system its own key and tick only what it needs (`employees:read`, `employees:write`, `attendance:read`, `payroll:read`). A key is shown once and stored only as a hash; it can be switched off at once. Calls are limited per key (120 a minute by default, `API_RATE_PER_MIN`).
- **REST API** under `/api/v1`: employees (list, one, create/update by code, resign/rejoin), departments, branches, shifts, daily attendance, raw punches (ask with `since_id` and you only get what is new), leave and finalized payroll. The page lists every call with an example; `GET /api/v1/docs` returns the same list without a key.
- **Webhooks** make this system call yours when something happens: a punch, an employee created/changed/left, leave requested/decided, a punch request, a device going offline or back, payroll finalized, a visitor in/out, a notification sent. Every delivery carries an `X-Signature` header (`sha256=` + HMAC-SHA256 of the body with the webhook's secret) so the receiver can check it came from here. A failed delivery is retried after 1 min, 5 min, 30 min, 2 h and 12 h, then marked failed; the Deliveries view shows each attempt and has a Retry. A receiver that is down never slows the app.
- WhatsApp, SMS and other channels: send the `notification.sent` (and any other) webhook to a service such as n8n or Zapier, which can forward it. **Door/access-control controllers are not connected**; that needs the controller's own interface and cannot be tested without it.

## Front desk and live view
- **Live monitor**: every branch at a glance (in, not in yet, late, on leave, devices up) and the latest punches, refreshing every 10 seconds. A person who has punched in and whose shift is still running counts as "in", not as a missing punch-out.
- **Dashboard**: each person chooses and orders their own widgets (waiting approvals, who is not in, late today, away today, latest punches, 7-day trend, devices, birthdays, anniversaries, people by department).
- **Visitors**: register in advance or sign in on arrival, badge numbers (a free number is reused), the host is told in the employee portal, who is inside now, staying-too-long warning, history with Excel export, and a blocked list that stops registration and sign-in.
- **Meetings**: rooms with seats, booking that refuses a double-booked room and a room too small for the guest list, warnings (not blocks) for guests who are on leave or already in another meeting, invitations and changes in the employee portal with Coming / Can't come, who attended, and minutes.

## Notifications, e-mail, temperature
- **Scheduled notifications** (Settings > Alerts): who is not in yet (to admins), late arrivals (to each manager), a reminder to anyone who forgot to punch out yesterday, and leave requests waiting more than 2 days. Each runs once a day at the time you set.
- **E-mail** is optional: set `SMTP_URL` (for example `smtps://user:password@smtp.example.com`), `MAIL_FROM` and, for admin copies, `ADMIN_EMAIL`, then restart. Employees need an e-mail address on their profile. Without it everything still works inside the app.
- **Temperature**: some face devices send a mask flag and a body temperature with each punch. When they do, it is stored, shown in the punch list and reports, and a reading at or above the limit in Settings raises an alert. This follows the common column layout and has not been checked on a real temperature device.

## Alerts, automation and the phone app
- **My alerts** (System menu): every staff login and every employee chooses which alerts they want (arrivals, late, leave and attendance requests, devices, visitors, contracts...), sets quiet hours and a watch list of people to follow. Switched-off alerts also disappear from the bell. Live punch alerts ("Ali punched in", "Sara is late") are made as punches arrive.
- **Automation** (System menu): rules of the form *when / if / then*. Triggers: a time every day (look at today's or yesterday's attendance), a person reaching N lates in a month, a leave or attendance request, a device going offline, a new employee. Actions: alert admins / the person / the manager, e-mail, call a web address, approve or reject a request. **Preview** shows exactly what a rule would do without doing it; a rule never acts twice for the same person and day.
- **Attendance policies** (Attendance menu): late, absent, half-day and missing-punch rules per department, group, branch or person (employee > group > department > branch > Settings).
- **Phone app**: open `/m` on the phone (same Wi-Fi), enter the 8-digit code from *My alerts > Connect a phone* (employees: portal > More > Alert settings). `/m` shows the alerts while it is open. The Android app (`android/`, build with `android/build-apk.sh`, result in `public/downloads/attendance-alerts.apk`) keeps one long request open to the server and shows notifications while the phone is locked; no Google/Firebase account is needed. Switch battery optimisation off for the app, otherwise some phones pause it. The APK has only been compiled, not run on a phone, in this project.

- **Break times** (Shifts page): save a break once ("Lunch 13:00-14:00") and give it to many shifts; editing it updates all of them. It is unpaid time: taken off the hours worked when the person was present during it.
- **Pay codes** (Attendance menu): the short code of each attendance status (used in monthly grids) and its **pay share** (1 = full day, 0.5 = half, 0 = unpaid). Payroll deducts the unpaid part, e.g. set Late to 0.9 to dock a tenth of a day per late arrival.
- **Training** is a third on-duty status next to On Duty and Work From Home: requested and approved like any attendance request, counts as a day worked.

- **Approval workflow** (System menu) and **Approvals** (Attendance menu): leave, attendance, shift and overtime requests can pass through up to 6 approvers in turn (the reporting manager, an admin, anyone with a role, or one user). A leave step can apply only from N days. A manager step is skipped for people without a manager; admins can decide any step; an automation rule that approves a request overrides the steps. Employees are told at each step; managers in the portal only see what is at their step.

## Payroll (Pakistan)
- **Salary** page: basic + allowances (taxable or not) = gross, revisions that start on the 1st of a month (earlier months keep the old salary), annual increment for everyone, CNIC, EOBI, SESSI/PESSI and bank details.
- **Tax and contributions** page: income tax slabs (annual), surcharge, EOBI (employee and employer share on the minimum wage), SESSI/PESSI (employer share up to a wage ceiling). The values that ship are only starting values: check them against the current FBR / EOBI / social-security notices and edit them there. Tax is estimated per month (monthly taxable pay x 12 through the slabs / 12), not a year-end return. Nothing is deducted until you switch tax on.
- **Approval**: with *Payroll approval* on, a month is submitted, an admin approves, then it can be finalized; if the numbers change after approval it needs approving again.
- **Payroll history** (finalized months and totals) and a **bank transfer file** (CSV) for a finalized month; people without a bank account are listed and left out.

## Employees: contracts, promotions, directory
Contracts (type, dates, probation, notice period; a new one replaces the one in force; reminders 30/14/7/1 days before it ends), promotions (designation, department and salary revision in one step, kept in the history) and a directory with birthdays and work anniversaries. Employees see a limited directory (name, role, department, e-mail) in the portal.

## Running it on the internet or in the cloud
- Put it behind a reverse proxy that has a real certificate (Caddy, nginx) and set `TRUST_PROXY=1` so limits and device address checks see the real client address. The server already sends no-sniff, no-framing, no-referrer and strict-transport headers.
- **Attendance devices identify themselves only by serial number, which is not a secret.** If the server is reachable from the internet, give every device an **allowed address list** (Devices > Manage, for example `203.0.113.7` or `192.168.1.0/24`); requests from anywhere else are refused and recorded. Better still, keep devices on a VPN or private network and expose only the https portal.
- Keep the database, the `.biokey` file and the backups on encrypted storage, and set a strong admin password.

## Dashboard, organization and device grids
The dashboard has a **Today** card (present against absent, and the device status: online / offline / unauthorized), a **Real-time monitor** (latest punches with photos, refreshed every 10 seconds), a **To do list**, and a **Monthly summary** of worked and overtime hours by department. Under Personnel > Organization, **Department** (code, superior, default shift, employee and resigned quantities, a structure tree, import, and **Personnel transfer** that moves people between departments and writes their history), **Position** and **Area**. **Devices** has the usual terminal columns (serial, area, IP, state, last activity, user / fingerprint / face quantities) and a toolbar: Add, Delete, New area, Clear pending command, Data clean, Data transfer and Device menu; **Device commands** lists everything queued for any device.

## Urdu and look
The employee portal (`/portal`) has an **اردو / English** switch: the screen is shown right-to-left and the fixed text is replaced from a built-in list (names, announcements and anything not in the list stay as written). The staff app has a light and a dark theme (button at the top right), a search box that jumps to any page (Ctrl+K or `/`), and a layout that works on a phone. The Android build is paused: `android/build-apk.sh` resumes its downloads (about 700 MB).

## SMS and WhatsApp
Automation rules can send an SMS or a WhatsApp message through any HTTP gateway you have an account with (nothing is built in, so no provider is forced on you). Set in the server's environment: `SMS_URL` (and `WA_URL` for WhatsApp), for example `SMS_URL='https://api.provider.example/send?key=SECRET&to={to}&text={text}'`. For a POST gateway also set `SMS_METHOD=POST`, `SMS_BODY='{"to":"{to}","message":"{text}"}'` and, if needed, `SMS_HEADERS='{"Authorization":"Bearer SECRET"}'`. `ADMIN_PHONE` lists the numbers that "the admins" means; `PHONE_COUNTRY` (default 92) is used for numbers that start with 0. Use **Preview** on the rule first: it shows who would get a message without sending anything.

## Access control
Menu **Access Control**: Doors (a relay of a device, remote open, sync), Time zones (up to 3 ranges a day), Access levels (people × doors × time zone) and Door events (punches outside policy are flagged and alerted). "Sync to devices" queues the zone/user commands (best effort, not verified on hardware). Device **messages** (public/private) are queued as `DATA UPDATE SMS` commands.

## ZKT-style pages
The classic look follows the real BioTime menu (Personnel, Device, Attendance, Access Control, System). Pages are built with `public/zkt.js` (`ZK.grid`) and the pack files `public/zkt-*.js`; backends are `zk-*.js`. Reference columns/buttons for every grid are in `docs/ref-bt-grids.txt` (brief for contributors: `docs/ZK-AGENT-BRIEF.md`). Tests: `e2e-zk-*.js`.


## Fingerprint from the browser (laptop scanner)
Device > Data > **Fingerprint**: click the circle and touch the laptop's own scanner (Touch ID / Windows Hello) to mark attendance; the person is recognised by the fingerprint and a punch is recorded (source `fingerprint`). **Add** registers a fingerprint on this laptop and/or starts enrolment on one or more devices (you pick them from the device list; the employee then scans on the device). Edit renames / re-scans, Delete removes it (from chosen devices too).
The browser only allows this on **https** (or http://localhost), so deploy behind TLS (`TLS_CERT`/`TLS_KEY`, see the portal section). The browser never reveals the fingerprint, so a laptop fingerprint cannot be copied to a device; devices enrol their own template (`ENROLL_FP`, unverified on real hardware).


## Install on Windows (Optix-Setup-<version>.exe) and on Linux / a Proxmox container
- **Windows:** run `npm run build:windows` (needs `makensis`: `brew install makensis`) -> `dist/ZKT-Setup-<version>.exe`. The wizard shows the install location, **HTTP port**, optional **HTTPS**, firewall choice, included SQLite database and backup folder before installation. It bundles Node, starts the server with Windows (scheduled task as SYSTEM, restarts itself) and adds a Start Menu shortcut. Existing installations keep their program and data folders; the data lives in `C:\ProgramData\OKT` and survives upgrades and uninstall. The selected backup folder is saved in `backup-path.txt` beside the database and used by the server launcher.
- **Linux / Proxmox CT:** `npm run build:linux` -> `dist/optix-1.0.0-linux-x64.tar.gz`. Copy it to the container, unpack, run `./install.sh --http 8080 [--https 8443]` as root. It installs to `/opt/optix`, data in `/var/lib/optix`, systemd service `optix`.
- **Ports and HTTPS afterwards:** System > Configuration > **Server Setting**: HTTP on/off + port, HTTPS on/off + port, automatic self-signed certificate or your own (PEM), redirect http to https (device paths `/iclock` stay on http), **Restart Now**. Saved in `server.json` next to the database. Environment variables `PORT`, `TLS_CERT`, `TLS_KEY` still override.
- Devices push attendance over plain http: keep HTTP on unless your devices support https.
- `launcher.js` restarts the server whenever it exits (restore, Restart Now). Running it directly: `node launcher.js` (data folder from `OPTIX_DATA`).

### Deployed
Proxmox CT 104 `optix` (Debian 12, 768 MB, starts on boot): http://192.168.30.94:8080 and https://192.168.30.94:8443 (self-signed certificate). Installed from `dist/optix-1.0.0-linux-x64.tar.gz` with `install.sh`. Startup takes about 20 seconds on first boot. Change the admin password after the first login.
