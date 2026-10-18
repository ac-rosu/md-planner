# Tasks are checklist items

```markdown
## Checkout

- [x] Data model & API contract @est:4h @act:5h @owner:alex ^T101
- [/] Order state machine @est:12h @owner:sam @dep:T101 ^T102
  - [ ] Order events schema @est:6h ^T104
- [ ] Payment provider integration @est:2d @owner:sam @start:2026-11-10 @prio:high #checkout ^T105
- [!] Payment form @est:6h @owner:priya @blocked:"waiting for API keys" ^T106
```

| Box   | Status        | Attribute           | Meaning                                 |
| ----- | ------------- | ------------------- | --------------------------------------- |
| `[ ]` | to do         | `@est:4h` `2d` `1w` | estimate                                |
| `[/]` | in progress   | `@owner:sam`        | person id from `team.md`                |
| `[?]` | review / test | `@dep:T101+2d`      | dependency, optional lag                |
| `[!]` | blocked       | `@start:` `@due:`   | fixed start, deadline                   |
| `[x]` | done          | `@act:5h`           | actual hours                            |
| `[-]` | cancelled     | `^T101`             | task id (assigned on save when missing) |

Completion, hovers, go to definition, rename and quick fixes help while you type.
