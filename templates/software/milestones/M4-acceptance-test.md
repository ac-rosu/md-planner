# M4 – Acceptance Test

id: M4
target: {{date:0.75}}
status: planned
depends: M2, M3

User acceptance test with the customer's key users on the staging environment.

- [ ] Acceptance test plan and test cases @test:UAT-01 #uat #documentation ^T301
- [ ] Staging environment with test data #uat ^T302
- [ ] Internal test round @dep:T301,T302 #uat ^T303
- [ ] Acceptance test with key users @dep:T303 #uat #customer ^T304
- [ ] Fix the bugs found in the acceptance test @dep:T304 #uat ^T305
