# Acceptance test – {{name}}

id: UAT-01
type: acceptance # acceptance | FAT | SAT | IT | unit
milestone: M4
witness: Key users

## TC-01 Sign in

pre: A test account for every role

- [ ] Sign in with a valid account → the dashboard is shown
- [ ] Wrong sign-in details → a clear error message that does not say which field was wrong

## TC-02 Main user flow

- [ ] Complete the main user flow from start to end
- [ ] The data is saved and shown again after a reload

## TC-03 Notifications

- [ ] Every notification and e-mail can be triggered and reads correctly
