# Punch list

Defects and open points from tests and reviews. Severity A blocks acceptance, B must be fixed
before go-live, C may be fixed after launch.

- [x] Wrong currency rounding on invoice totals @sev:B @owner:jordan @due:2026-10-16 @done:2026-10-12 @from:UAT-01/TC-01 ^P001
- [ ] Error text for an expired card is missing @sev:C @owner:priya @from:UAT-01/TC-02 #notifications ^P002
- [/] Cart is not cleared after a cancelled payment @sev:A @owner:sam @due:2026-10-23 @started:2026-10-13 @from:UAT-01/TC-01 ^P003
- [!] VAT rates differ from the finance spreadsheet @sev:B @owner:alex @blocked:"waiting for finance" ^P004
- [ ] Payment confirmation after 3.5 s instead of 2 s @sev:B @owner:sam @due:2026-11-20 @from:UAT-01/TC-01 ^P007
