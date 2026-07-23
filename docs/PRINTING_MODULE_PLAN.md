# JCC Jobs — Printing Module: Implementation Plan

> Status: **DRAFT for approval** · Owner: engineering · Last updated: 2026-07-10
>
> This document is the agreed spec **before any code is written**. Nothing here is
> built yet. Once you approve (or edit) it, we build in the phased order at the end.

---

## 1. Guiding principle — reuse the JCC skeleton

The Printing Module is a **sibling to the existing JCC/voucher module**. It reuses,
unchanged, the infrastructure JCC already relies on:

| Concern | Reused from | Notes |
|---|---|---|
| Auth / device-binding | `authenticateToken`, `authorizeRoles` | no change |
| In-app notifications | `notifications` table | new event types only |
| Email | `emailService` (`PESDT@larsentoubro.com` relay) | new templates only |
| Audit trail | `audit_logs` table | new action names only |
| File uploads | existing `uploads/` handling | PDFs stored the same way |
| UI shell / styling | `AppShell`, `voucher-styles.css` | new pages match the JCC look |

New code is limited to: **2 tables**, **1 column on `projects`**, **1 route file**,
and **a set of new pages**. No rewrite of anything existing.

---

## 2. Roles mapping

| Workflow actor | Maps to existing role | Decision |
|---|---|---|
| Requestor | `initiator`, `user` (and `admin`) | reuse — same as JCC creators |
| Printing Coordinator | `coordinator` | reuse — role already exists |
| Administrator | `admin` | reuse |
| **Printer Operator** | reuse `user` **+ an `is_printer_operator` flag** | see below |

### Printer Operator — how we "reuse an existing role"
You chose *reuse an existing role* rather than adding a new `printer_operator` role
(which would need a `users` table CHECK-constraint migration). The clean way to do
that without operators and requestors colliding:

- Operators keep their normal role (`user`).
- Add a lightweight **`is_printer_operator` (0/1) flag** on `users`, toggled by an
  admin in User Management.
- The coordinator can only assign a job to a user whose flag is `1`.
- A user with the flag sees the **Operator dashboard**; without it they don't.

This needs **no CHECK-constraint change** (safe) and keeps the "operator" concept
explicit. If you'd rather use a pure role after all, that's a one-line change to the
constraint migration already present in `server/database.js` — flag it and we switch.

> **Open item to confirm:** OK with the `is_printer_operator` flag approach? (Slice C only.)

---

## 3. Identifiers — Request ID vs Job Number

The workflow deliberately has **two** identifiers:

- **Request ID** — generated in **Phase 1** the moment a request is created (draft stage). Format `REQ0001`.
- **Job Number** — generated in **Phase 3** at final submission. Format `JOB0001`.

So a not-yet-submitted request has a `request_id` but a `NULL` `job_number` until submit.

---

## 4. Data model

### 4.1 `projects` — add one column (Phase 1 debit-code dropdown)
```sql
ALTER TABLE projects ADD COLUMN debit_code TEXT;
```
- Debit-code dropdown = `SELECT DISTINCT debit_code FROM projects WHERE debit_code IS NOT NULL`.
- Selecting a debit code filters projects: `SELECT project_name FROM projects WHERE debit_code = ?`.
- Admin maintains `debit_code` per project in the existing Project Management screen (small add).

### 4.2 `print_jobs` — the request header
```sql
CREATE TABLE IF NOT EXISTS print_jobs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id            TEXT UNIQUE NOT NULL,        -- REQ0001 (Phase 1)
  job_number            TEXT UNIQUE,                 -- JOB0001 (Phase 3, NULL until submit)
  request_date          DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Form 1 (Phase 1)
  employee_name         TEXT,
  employee_id           TEXT,
  department_name       TEXT,
  department_code       TEXT,
  debit_code            TEXT,                        -- mandatory
  project_name          TEXT,                        -- filtered by debit_code
  dt_number             TEXT,
  remarks               TEXT,

  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'draft',
  created_by            INTEGER NOT NULL,            -- requestor (users.id)
  coordinator_id        INTEGER,                     -- who verified
  coordinator_remarks   TEXT,
  return_reason         TEXT,
  reject_reason         TEXT,
  assigned_operator_id  INTEGER,

  -- Timestamps per phase (for tracking + reports)
  submitted_at          DATETIME,
  accepted_at           DATETIME,
  returned_at           DATETIME,
  rejected_at           DATETIME,
  assigned_at           DATETIME,
  printing_started_at   DATETIME,
  printing_completed_at DATETIME,
  ready_at              DATETIME,
  completed_at          DATETIME,

  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by)           REFERENCES users(id),
  FOREIGN KEY (coordinator_id)       REFERENCES users(id),
  FOREIGN KEY (assigned_operator_id) REFERENCES users(id)
);
```

### 4.3 `print_job_documents` — one row per document (Phase 2)
A job has **many** documents.
```sql
CREATE TABLE IF NOT EXISTS print_job_documents (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              INTEGER NOT NULL,
  document_name       TEXT NOT NULL,
  quantity            INTEGER NOT NULL CHECK(quantity > 0),
  pdf_path            TEXT NOT NULL,        -- mandatory upload
  num_pages           INTEGER,
  print_side          TEXT,                 -- 'single' | 'double'
  paper_size          TEXT,                 -- A4, A3, Letter, Legal...
  paper_gsm           TEXT,                 -- 70, 80, 100...
  color_mode          TEXT,                 -- 'color' | 'bw'
  cover_page          TEXT,                 -- description / yes-no
  soft_lamination     INTEGER DEFAULT 0,    -- 0/1
  separators          INTEGER DEFAULT 0,    -- 0/1
  separator_thickness TEXT,
  hole_punch          INTEGER DEFAULT 0,    -- 0/1
  binding_type        TEXT,                 -- spiral, wiro, perfect, staple, none...
  file_colour         TEXT,
  remarks             TEXT,
  -- Slice C finishing checklist (operator ticks these off)
  finishing_done      INTEGER DEFAULT 0,    -- 0/1
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES print_jobs(id) ON DELETE CASCADE
);
```

### 4.4 Queue — computed, never stored (Phase 5)
Queue position is derived on read, so it self-heals when jobs advance:
```sql
SELECT job_number,
       ROW_NUMBER() OVER (ORDER BY submitted_at ASC) AS queue_position
FROM print_jobs
WHERE status = 'accepted';   -- FCFS by submission date/time
```

---

## 5. Status state-machine

```
draft ──submit──▶ submitted (Pending Coordinator Verification)
                     │
   ┌─────────────────┼─────────────────────────┐
   │ (coordinator)   │ (coordinator)            │ (coordinator)
   ▼                 ▼                          ▼
 returned          rejected                  accepted ──▶ [FCFS queue]
   │              (reason req,                    │
 (user edits)      terminal)                      ▼ (coordinator assigns)
   │                                          assigned
   └──resubmit──▶ submitted                       │ (operator: Start)
                                                  ▼
                                              printing ◀──resume── paused
                                                  │  └──pause──▶ paused
                                                  ▼ (operator: finish + QC)
                                          printing_completed
                                                  │ (operator)
                                                  ▼
                                          ready_for_collection
                                                  │ (requestor collects + coordinator verifies)
                                                  ▼
                                              completed  (read-only + audit)
```

### Transition authority (who may do what)
| From → To | Actor | Guard |
|---|---|---|
| draft → submitted | Requestor (owner) | ≥1 document, each has PDF + qty>0 |
| submitted → accepted | Coordinator | — |
| submitted → returned | Coordinator | remarks mandatory |
| submitted → rejected | Coordinator | reason mandatory (terminal) |
| returned → submitted | Requestor (owner) | edits then resubmits (same Request ID/Job Number) |
| accepted → assigned | Coordinator | operator has `is_printer_operator=1` |
| assigned → printing | Operator (assigned) | — |
| printing ↔ paused | Operator (assigned) | — |
| printing → printing_completed | Operator (assigned) | finishing + QC done |
| printing_completed → ready_for_collection | Operator (assigned) | — |
| ready_for_collection → completed | Coordinator (verifies handover) | becomes read-only |
| any active → cancelled | Owner/Admin | (optional; approval-gated per your note) |

---

## 6. API surface (`server/routes/jobs.js`, mounted at `/api/jobs`)

All routes behind `authenticateToken`; write routes role-guarded as noted.

**Slice A — request + submission + requestor tracking**
- `POST   /api/jobs`                    create draft → returns `request_id`  *(initiator/user/admin)*
- `PUT    /api/jobs/:id`                edit draft/returned request
- `POST   /api/jobs/:id/documents`      add a document (+ PDF upload)
- `PUT    /api/jobs/:id/documents/:docId`  edit a document
- `DELETE /api/jobs/:id/documents/:docId`  delete a document
- `POST   /api/jobs/:id/submit`         validate → generate `JOB0001` → status `submitted`
- `GET    /api/jobs/mine`               requestor's jobs + status + queue position
- `GET    /api/jobs/:id`                job + documents (owner/coordinator/assigned-operator/admin)
- `GET    /api/jobs/:id/documents/:docId/file`  download PDF (access-checked)
- `GET    /api/projects/debit-codes`    distinct debit codes  *(for the dropdown)*
- `GET    /api/projects?debit_code=X`   projects for a debit code

**Slice B — coordinator + queue + assignment**
- `GET  /api/jobs/pending`              coordinator queue of `submitted`  *(coordinator/admin)*
- `POST /api/jobs/:id/accept`
- `POST /api/jobs/:id/return`           { remarks }
- `POST /api/jobs/:id/reject`           { reason }
- `GET  /api/jobs/queue`                accepted jobs with computed FCFS positions
- `GET  /api/jobs/operators`           users with `is_printer_operator=1`
- `POST /api/jobs/:id/assign`           { operatorId }

**Slice C — operator + finishing + collection + reports**
- `GET  /api/jobs/assigned`            operator's assigned jobs  *(operator/admin)*
- `POST /api/jobs/:id/start` · `/pause` · `/resume`
- `PUT  /api/jobs/:id/documents/:docId/finishing`  tick finishing checklist
- `POST /api/jobs/:id/complete-printing`
- `POST /api/jobs/:id/ready`
- `POST /api/jobs/:id/collect`         coordinator verifies handover → `completed`
- `GET  /api/jobs/reports/...`         role-scoped report endpoints (Phase 12)

---

## 7. Frontend screens

| Route | Page | Slice | Who |
|---|---|---|---|
| Dashboard chooser cards | (section on `DashboardPage`) | A | all |
| `/job-creation` | `JobCreationPage` — Form 1 → multi-document form → submit | A | requestor |
| `/job-history` | `JobHistoryPage` — My Jobs, status, queue position, history | A | requestor |
| `/print-coordinator` | `PrintCoordinatorPage` — pending, accept/return/reject, queue, assign | B | coordinator |
| `/print-operator` | `PrintOperatorPage` — assigned jobs, start/pause, finishing, ready | C | operator |
| `/print-reports` | reports by role | C | coordinator/admin |

The **chooser** (your ask): after login on the dashboard, two cards —
**📄 Create JCC → `/create-voucher`** and **🖨 Printing Request → `/job-creation`**.

Job creation is a **two-step wizard** mirroring your workflow: Step 1 = Form 1
(Request Information), Step 2 = Documents (add/edit/delete rows) → Submit.

---

## 8. Notifications matrix (Phase 11)

Each event → in-app + email, reusing existing services.

| Event | Recipients |
|---|---|
| New Request Submitted | Coordinator |
| Request Accepted | Requestor |
| Request Returned | Requestor |
| Request Rejected | Requestor |
| Job Assigned | Assigned Operator |
| Printing Started | Requestor, Coordinator |
| Printing Paused | Coordinator |
| Printing Completed | Requestor, Coordinator |
| Ready for Collection | Requestor, Coordinator |
| Job Completed | Requestor, Coordinator |

---

## 9. Tracking & reports (Phase 12)

| Role | Sees |
|---|---|
| Requestor | My Jobs · Current Status · Queue Position · History |
| Coordinator | Pending Jobs · Accepted Jobs · Queue · Operator Workload · Department Stats |
| Operator | Assigned Jobs · In Progress · Completed · Daily Workload |
| Administrator | Overall Dashboard · Department Reports · User Management · Audit Logs · Performance |

All derived from `print_jobs` + `print_job_documents` timestamps + `audit_logs`.

---

## 10. Phased delivery

- **Slice A — Foundation** (Phases 1–3, 12-requestor)
  Chooser cards · `projects.debit_code` + admin edit · `print_jobs` + `print_job_documents`
  tables · Form 1 + multi-document wizard + PDF upload · Request ID / Job Number
  generation · submit · My Jobs tracking. **Usable end-to-end on its own.**

- **Slice B — Coordinator & Queue** (Phases 4–6, 11-partial)
  Pending Jobs · Accept/Return/Reject · FCFS queue view · assign to operator ·
  notifications for these events.

- **Slice C — Operator, Finishing, Closure & Reports** (Phases 7–10, 12-rest)
  Operator dashboard · start/pause/resume · finishing checklist · ready-for-collection ·
  coordinator handover/closure (read-only + audit) · role-based reports · `is_printer_operator` flag.

---

## 11. Open items to confirm before Slice A
1. **Operator identity** — OK with the `is_printer_operator` flag (§2), or use a pure role?
2. **Debit code data** — who enters `debit_code` per project, and do you have the list, or seed empty and fill later?
3. **Nav placement** — Printing links only from the dashboard chooser, or also add sidebar nav links per role?
4. **Job Number format** — `JOB0001` (matches `JCC0001`), or a different scheme (e.g. year prefix `JOB-2026-0001`)?
