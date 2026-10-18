# A plan is a folder of Markdown files

```text
plan/
  project.md            name, start/end, work week, holidays
  team.md               people: capacity, skills, time off
  milestones/
    M1-discovery-design.md   one file per milestone (id, target, depends)
    M2-backend.md
  tests/UAT-01-checkout.md   test plans: cases and steps
  punchlist.md          defects and open points (^P001 …)
  inbox.md              ideas not yet planned
```

Everything stays plain text: diff it, review it in pull requests and edit it in any editor. The
schedule is computed, never written back into your files.

Try it with **Planner: New project…**, which creates the folder from a template.
