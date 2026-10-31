---
name: audit-pack
description: Build a zip of Bosun's invoices + GST reports for the auditor / CA — every SW/ invoice as PDF, Sale/Purchase/GSTR-1/GSTR-2/GSTR-3B per month, and CSV registers of invoices, purchases and payments received. Use when asked for "invoices for the auditor", "GST documents", "audit pack", "send the CA the month's invoices", or "/audit-pack [YYYY-MM]".
---

# Auditor pack

Read-only against production Firestore (`bosun-76bba`, via ADC). Nothing is written, emailed or
uploaded unless the user asks.

## 1. Pick the period

- An argument / a month named ("October", "Oct 2026", `2026-10`) → that IST month, `YYYY-MM`.
- "all", "everything", "since start" → no month argument (every month since the first invoice,
  plus a whole-period folder).
- Nothing said → don't ask; default to the **previous complete month** if today is in the first
  week of a month, else the **current month**, and say which you chose.

## 2. Build it

```bash
S=<scratchpad>/audit-pack-<period>
rm -rf "$S" && cd functions && node scripts/export-audit-pack.mjs "$S/Bosun audit pack <label>" [YYYY-MM]
cd "$S" && zip -qr "Bosun audit pack <label>.zip" "Bosun audit pack <label>"
```

`<label>` = e.g. `Oct 2026`, or `2026-07 to 2026-10` for the whole history. The script prints
`invoices N, purchases N, payments N` — keep those counts for the summary.

Layout of the zip:
- `01 Sales invoices/` — `SW-<fy>-<seq> <BUYER>.pdf` (rendered by `utils/invoice.js#renderInvoiceHtml`
  through playwright chromium `--print-to-pdf`, stamped with the LIVE paid status).
- `02 GST reports/<YYYY-MM>/` — the five `GST_REPORTS` (`utils/gstReport.js`), same build/render as
  `adminGstReport`; Purchase Report sees every bill, GSTR-2/3B only `reportablePurchases`.
- `03 Registers/` — `Sales invoice register.csv`, `Purchase register.csv`, `Payments received.csv`
  (for a month: payments RECEIVED in that month, which can settle earlier months' invoices).

## 3. Check before handing over

- Render page 1 of one invoice and the GSTR-3B to PNG (`pdftoppm -png -r 50 -f 1 -l 1`) and look at
  them — catches a broken chromium/font path.
- From `03 Registers/Sales invoice register.csv`: total taxable / CGST / SGST / IGST / invoice value,
  and every row whose `paymentStatus` isn't `paid` (the receivables the auditor will see).
- **Purchases = 0 is a finding, not a pass.** The software line buys Anthropic API credits every
  month; an empty purchase register means the bills were never recorded (Admin → Purchases), so
  GSTR-2 and the 3B ITC section are blank. Say so and offer to regenerate once they're entered.
- A current-month pack is as of today — say it must be rerun after month-end.

## 4. Deliver

Send the zip with `SendUserFile` (`display: 'attach'`) and give its full absolute path. Then a short
summary: period, invoice range + count, totals, payments received, unpaid invoices, the purchases
gap if any. Email / Drive (folder "Invoices", see the drive-upload memory) only when asked —
it's the auditor's copy of financial records, so confirm the recipient first.
