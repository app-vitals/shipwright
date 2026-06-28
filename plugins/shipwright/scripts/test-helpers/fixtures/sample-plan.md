# Plan: widget-dashboard

Repo: example-app

## Technical Design

Add a server-rendered widget dashboard to the admin UI so operators can see
live widget counts without opening the database. The page reuses the existing
layout shell and fetches counts through the metrics service.

### Views/UX

- A summary card row at the top of the dashboard.
- A sortable table of widgets below the cards.

## Task Table

| ID      | Title                            | Layer    | Complexity | Model  | Hours | Branch                         | Deps            |
|---------|----------------------------------|----------|------------|--------|-------|--------------------------------|-----------------|
| WID-1.1 | Add widget count endpoint        | API      | 2          | sonnet | 3     | feat/wid-1-1-count-endpoint    | —               |
| WID-1.2 | Render dashboard summary cards   | Frontend | 3          | sonnet | 4     | feat/wid-1-2-summary-cards     | WID-1.1         |
| WID-1.3 | Render sortable widget table     | Frontend | 2          | haiku  | 2     | feat/wid-1-3-widget-table      | WID-1.1         |
| WID-2.1 | Wire dashboard into admin nav    | Plugin   | 1          | haiku  | 1     | feat/wid-2-1-admin-nav         | WID-1.2, WID-1.3 |

## Dependency Map

```
WID-1.1 ──┬─> WID-1.2 ──┐
          └─> WID-1.3 ──┴─> WID-2.1
```

## Key Decisions

- Counts are computed in the metrics service, not the admin DB, to avoid a new query path.
- The table is server-rendered for the MVP; client-side sorting is a follow-up.
