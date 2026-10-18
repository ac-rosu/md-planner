# Acceptance test – Checkout

id: UAT-01
type: acceptance # acceptance | FAT | SAT | IT | unit
milestone: M4
eq: checkout
witness: Customer key users

## TC-01 Successful purchase

pre: Signed-in customer with an empty cart

- [x] Add a product and open the cart → total with VAT shown @result:pass
- [x] Pay with a test card → confirmation within 2 s @result:fail @note:"confirmation after 3.5 s" @punch:P007
- [ ] Order appears in the order history

## TC-02 Declined card

- [ ] Declined card → clear error message, the cart is kept

## Run 2026-10-12

tester: Alex
witness: internal dry run
result: 1 pass, 1 fail, 0 n.a., 2 open (4 steps)
failed: TC-01
punch: P007
