# M5 – Launch

id: M5
target: 2027-03-26
status: planned
depends: M4

Production environment, load tests, data migration, pilot go-live and go-live acceptance.

## Infrastructure

- [ ] Production environment setup @est:3d @owner:jordan #ops #infrastructure ^T401
- [ ] Integration and load tests @est:5d @owner:jordan @dep:T401 #ops #integration ^T402

## Rollout

- [ ] Data migration dry run @est:5d @owner:alex @dep:T402 #ops #rollout ^T403
- [ ] Pilot go-live @est:5d @owner:sam @dep:T403 #ops #rollout ^T404
- [ ] Support team training @est:2d @owner:priya @dep:T403 #ops #training ^T405

## Go-live

- [ ] Go-live acceptance @est:3d @owner:maria @dep:T404 @test:UAT-02 #golive ^T406
- [ ] Release notes and runbook @est:3d @owner:maria @dep:T406 #documentation ^T407
