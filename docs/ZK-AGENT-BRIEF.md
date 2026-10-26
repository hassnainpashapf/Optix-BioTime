# Brief: make every page of ~/biotime-clone match the reference BioTime menu 1:1

The user wants the app's pages to match the real BioTime they run locally: same menu, same page names, same
toolbar buttons (incl. dropdown "More/Data Transfer" style menus), same table columns and the same kind of data.
Reply language to the user is not your concern; write code/comments in English.

## Reference material
* `docs/ref-bt-grids.txt` - for every data-grid page of the real app: menu path, URL, exact column titles, exact toolbar actions
  (`Name{Sub/Sub}` = dropdown). `docs/ref-bt-grids.json` has the raw grid JSON (field names, widths, action list).
* The real app runs at http://127.0.0.1:8090 (login admin / Admin@12345, started by ~/biotime-run/start.sh; if down, run it).
  Pages are fragments: `/personnel/employee/` returns the HTML fragment (filter panel lists the filterable columns), the grid
  definition is at the `path = "..."` URL inside it (e.g. `/personnel/employee/table/`), rows at that url + `?page=1&limit=20`.
  Add/edit forms: GET the `add_url`/`edit_url` fragments to read the form field labels. Report pages (`/att/report/...`) are not
  data grids: open the fragment and read the query form + the column titles in its JS. Use CDP headless Chrome (see
  /private/tmp/claude-501/-Users-hussnainpasha/70c1a62c-39a5-41a8-8d94-12b2b1827985/scratchpad/btscrape.mjs for a working login+navigate+evaluate script).
* IMPORTANT: copy only labels/columns/behaviour you observe. Do NOT copy BioTime source code, and never touch its license modules.

## Our UI framework (public/zkt.js - read it first, ~70 lines)
* `ZK.grid(key, title, spec)` builds a ZKT-style page (toolbar buttons + checkbox table + pager) - see header comment of zkt.js.
  `ZK.reg(key, title, async()=>html, module)` registers a custom page. `ZK.form(...)`, `ZK.csvModal(...)` helpers exist.
  `module` is the RBAC module name used in PAGE_MODULE (employees, organization, shifts, attendance, leave, overtime, payroll, devices, access, settings, '@admin').
* Menu is already restructured in public/index.html (`const MODULES`). Items are `[label, pageKey]`; keys that are new start with `zk:` and are
  listed there (grep `zk:` in index.html). Existing pages (Department, Position, Area, Employees, Devices, Device commands, Shifts, Roster, Leaves, Holidays,
  Overtime, Requests, Pay codes, Reports, Doors, Time zones, Access levels, Audit log, Notifications, ...) keep their old keys; to make one match the
  reference, re-register the SAME key from your pack file (`ZK.reg('Department', 'Department', fn, 'organization')` / `ZK.grid('Department', ...)`);
  your pack file loads after index.html so it overrides `pages[key]`.
* DO NOT edit public/index.html (other agents work in parallel). Put UI in your own pack file `public/zkt-<area>.js`, and tell the lead
  its filename (the lead adds the `<script>` tag). If you truly need a change in index.html, describe it in your final report instead.
* Look: classic skin only matters. Text 13px, flat grey buttons; do not add decoration. Use `esc()`, `api(path, method, body)`, `tbl()`, `zcol/zsel`, `orgModal`, `today()`.
* Server: Node 26 + node:sqlite + Express, one router per feature (see org.js, ac.js, devices.js for the style: `fail(res,msg,code)`, `scopeClause`,
  `db.prepare`, `export const xRouter = express.Router()`; routes are under /api and wired in server.js with `app.use('/api', xRouter)`).
  Create your OWN backend file(s) `zk-<area>.js` (+ tables via `db.exec('CREATE TABLE IF NOT EXISTS ...')` inside it, NOT in db.js) and add one line to
  server.js to mount it, and one line in rbac.js prefix map if needed (re-read the file right before editing: others edit those lines too; use small unique Edit replacements).
  Reuse existing data/APIs wherever the app already has the concept (employees, departments, designations, branches(=areas), devices, punches/transactions,
  leaves, overtime_requests, attendance_requests, shifts, holidays, pay codes, reports.js, audit_log, device_events, device_commands, portal accounts...);
  create new tables only for concepts we do not have. Every page must work for real (add/edit/delete/import/actions do something sensible and are tested),
  not be a dead mock. Where a button depends on hardware (device push), queue a device command via `queueCommand` like devices.js does.
* Tests: plain-node e2e in the style of e2e-ac.js / e2e-wfrole.js (`startServer()` from e2e-lib.js). One new file `e2e-zk-<area>.js` per agent that exercises
  your endpoints (CRUD, validation errors, actions, permissions of at least one restricted role). Run `node test.js` and the e2e files you could affect
  (e2e-*.js) before reporting; do not break existing tests. DO NOT edit package.json (the lead appends your test file).
* Visual check: start your own server instance, never kill others: `DB_FILE=/tmp/zk-<area>.db PORT=<yourport> node server.js` (seed with
  `cp /tmp/demo-att/demo.db /tmp/zk-<area>.db` first; login admin/demo123). Screenshot pages with CDP (copy
  scratchpad/acshot.mjs/nshot.mjs patterns: login via `login()`, then `window.MOD='<Module>'; go('<key>')`, `Page.captureScreenshot`) and compare with the real app's page
  (screenshot of http://127.0.0.1:8090 the same page). Fix visible differences in columns/buttons/text.
* Ports: personnel+device agent 8101, attendance setup agent 8102, reports agent 8103, access+system agent 8104.
* Finish with a short report: pages done (keys), backend files, test files, anything you could not match and why.
