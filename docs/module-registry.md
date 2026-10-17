# Approved Module Registry

The catalogue is intentionally limited to the thirteen approved nodes. `src/domain.ts` defines each module's stable key, inputs, outputs, editable fields, color, and builder metadata. The API accepts only these keys and validates edge types before saving.

`MODULE_FIELD_SCHEMAS` currently drives the generated Inventory and Request forms, including required fields and numeric constraints. The remaining modules expose typed registry metadata and configured builder fields, but do not yet share one generic form renderer.

| # | Module | Node key | Inputs → outputs | Site surface |
| --- | --- | --- | --- | --- |
| 1 | Authentication and RBAC | `auth` | none → `Session` | Global sign-in and scoped role checks. |
| 2 | User Management | `users` | `Session` → `Member` | Site membership and role administration. |
| 3 | Inventory | `inventory` | `Session` → `StockItem` | Stock ledger, reorder status, calculated value. |
| 4 | Dashboard Shell / Navigation / Forms | `shell` | `Session` → `Page` | Site theme and generated navigation. |
| 5 | Request | `request` | `Member`, `StockItem` → `Request` | Site-scoped request intake. |
| 6 | Approval | `approval` | `Request` → `ApprovedRequest` | Manager decision and audit record. |
| 7 | Material Assignment | `material-assignment` | `ApprovedRequest`, `StockItem` → `Assignment` | Transactional stock issue. |
| 8 | Assignment Frontend | `assignment-ui` | `Assignment` → `Receipt` | Field assignment queue. |
| 9 | Consumption Tracking | `consumption` | `Assignment` → `Consumption` | Usage capture against an assignment. |
| 10 | Return Management | `returns` | `Assignment`, `Consumption` → `Return` | Return condition and disposition. |
| 11 | PCB Repair | `pcb-repair` | `Request` → `RepairLog` | Repair diagnostics and work log. |
| 12 | Analytics Dashboard | `analytics` | `StockItem`, `Request`, `Assignment` → `Insight` | Site-filtered KPI and inventory charts. |
| 13 | Reports with Excel Integration | `reports` | `StockItem`, `Request`, `Assignment` → `Workbook` | Role-restricted Excel import and export. |

## Type rule

An edge is valid only when `source.outputs` and `target.inputs` contain the same type. For example, `Request → Approval` is valid because `Request` is emitted and accepted. `Request → Material Assignment` is invalid because the assignment node requires `ApprovedRequest`, not `Request`.

## Presets

| Preset | Assembled modules |
| --- | --- |
| Inventory Starter | Authentication, User Management, Shell, Inventory, Analytics, Reports. |
| Approval Chain | Authentication, User Management, Shell, Inventory, Request, Approval, Material Assignment, Assignment Frontend, Consumption, Returns. |
| Repair Shop | Authentication, User Management, Shell, Request, Approval, PCB Repair, Returns, Analytics, Reports. |