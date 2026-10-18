# M2 – Backend

id: M2
target: 2026-12-15
status: active # planned | active | done | cancelled
depends: M1

Services and APIs for accounts, checkout and billing on the new cloud platform, with an
event-driven order flow and a shared library for authentication, validation and logging.

## Common

- [x] Repository, CI pipeline and project setup @est:8h @act:6h @owner:sam @started:2026-10-05 @done:2026-10-06 #backend ^T120
- [ ] Shared API library (auth, validation, logging) @est:3d @owner:sam #backend ^T121
- [ ] Notifications and e-mail service @est:12h @owner:sam @dep:T121 #backend #notifications ^T122

## Checkout

- [x] Data model & API contract @est:4h @act:5h @owner:alex @done:2026-10-09 ^T101
- [/] Order state machine @est:12h @owner:sam @dep:T101 #checkout ^T102
  - [x] State transitions @est:6h @act:7h @started:2026-10-12 @done:2026-10-13 ^T103
  - [ ] Order events schema @est:6h ^T104
        Notes indented under a task are its description.
        Use the CloudEvents format; order and payment events only for now.
- [ ] Payment provider integration @est:2d @owner:sam @start:2026-11-10 @prio:high @eq:checkout/payment #checkout ^T105
- [!] Payment form @est:6h @owner:priya #frontend @blocked:"waiting for the payment provider API keys" ^T106
- [ ] Checkout flow (cart, pay, confirm) @est:1w @owner:alex @dep:T102,T105 @eq:checkout #checkout ^T107
- [ ] Checkout integration tests @est:8h @owner:maria @dep:T107 @test:UAT-01 #test ^T108

## Accounts

- [ ] Account and profile services @est:4d @owner:alex @dep:T121 @eq:accounts #accounts ^T110
- [ ] Login and single sign-on @est:3d @owner:alex @dep:T110 @due:2026-12-04 #accounts ^T111
- [ ] Password reset and e-mail verification @est:12h @dep:T111 #accounts ^T112

## Billing

- [ ] Invoice generation (draft, issue, credit note, PDF) @est:5d @owner:sam @dep:T121 @eq:billing @src:src/server/invoices.ts#L8 #billing ^T113
- [ ] Payment retries and dunning @est:2d @owner:sam @dep:T113 @security:high #billing ^T114
- [-] Legacy PDF statement export @est:1d @owner:sam #billing ^T115

## Notes

Free text is allowed anywhere and is preserved. The data migration plan is tracked separately.
