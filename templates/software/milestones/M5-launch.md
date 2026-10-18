# M5 – Launch

id: M5
target: {{end}}
status: planned
depends: M4

## Infrastructure

- [ ] Production environment #ops ^T401
- [ ] Load and security tests @dep:T401 #ops #security ^T402

## Rollout

- [ ] Data migration dry run @dep:T402 #rollout ^T403
- [ ] Pilot go-live @dep:T403 #rollout ^T404
- [ ] Support team training @dep:T403 #training ^T405

## Go-live

- [ ] Go-live and acceptance @dep:T404 #golive ^T406
- [ ] Release notes and runbook @dep:T406 #documentation ^T407
