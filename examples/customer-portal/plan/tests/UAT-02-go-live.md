# Go-live acceptance – Checkout

id: UAT-02
type: acceptance
milestone: M5
eq: checkout
witness: Customer product owner

## TC-01 Production purchase

pre: Production live, pilot group enabled, monitoring green

- [ ] Pilot customers complete a purchase within 5 min
- [ ] 1,000 orders processed without errors
- [ ] Error rate below 0.5 %

## TC-02 Daily reconciliation

- [ ] Orders at the end of the day match the payment provider report
