# M4 – Acceptance Test

id: M4
target: 2027-02-12
status: planned

User acceptance test with the customer's key users on staging, with production-like data.

- [ ] Acceptance test plan and test cases @est:3d @owner:maria @test:UAT-01 #uat #documentation ^T301
- [ ] Staging environment with test data @est:4d @owner:sam @dep:T107 #uat ^T302
- [ ] Internal test round @est:3d @owner:maria @dep:T301,T302,T205 #uat ^T303
- [ ] Acceptance test with key users @est:3d @owner:alex @dep:T303+2d @start:2027-02-01 #uat #customer ^T304
- [ ] Fix acceptance test bugs (A and B) @est:2d @owner:sam @dep:T304 #uat ^T305
