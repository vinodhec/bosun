# Bosun — Tax & GST Structure: Note for CA

**Date:** 30 June 2026
**Prepared for:** [CA name]
**Business owner:** [Father's name] (existing proprietorship)
**Proposed activity:** A new software (SaaS) product line — "Bosun" — to be run **under the existing proprietorship**.

## 1. What the business does
Bosun is a **self-serve software product**: small business owners describe a website problem, and an automated AI system fixes it and bills them. There is **no bespoke client consulting** — it is a standardised, automated product sold to many customers at list price.

**How customers pay (prepaid wallet):**
- A customer **recharges a wallet** with spendable credit (e.g. ₹5,000).
- A **10% platform fee** is added on top of the recharge (₹500 on a ₹5,000 recharge).
- **18% GST** is charged on top of *(recharge credit + platform fee)* at the point of recharge.
- Each website fix then **draws down the wallet** at a per-use price (cost-plus, roughly ₹149–₹749 per fix; larger items quoted). Fixes debit the already-taxed wallet — **no further GST per fix**.

So the **taxable event is the recharge**, on the full pre-GST amount (credit + fee). We propose to **issue one GST tax invoice per recharge** (not monthly, not per fix), because GST time-of-supply for services falls on the earlier of invoice or payment, and the recharge is when payment is received.

- **Main input cost:** Anthropic (US-based AI API) — a foreign supplier.
- **Other costs:** Google Firebase/Cloud hosting, domain, payment gateway.
- **Customers:** mix of (a) GST-registered businesses (e.g. property/listing platforms) and (b) small unregistered shops.

## 2. Proposed structure (please confirm)

| Element | Proposed treatment |
|---|---|
| **Legal entity** | Run under father's existing **proprietorship** (same PAN/GSTIN) |
| **GST** | **Normal registration with ITC** (not composition). Charge 18% on output; claim input credit |
| **Anthropic (foreign input)** | Treat as **import of service → Reverse Charge (RCM)**: self-invoice, pay 18% IGST, reclaim as ITC |
| **Income tax** | **Presumptive u/s 44AD** — declare **6% of digital turnover** as deemed profit, taxed at proprietor's slab |
| **Vendor accounts** | Anthropic, Firebase, gateway all in the **business name**, paid from the **business current account** |

## 3. Five questions I need you to confirm

1. **44AD vs 44ADA — is this a "business" (6%) or a "profession" (50%)?**
   Our position: it is a **business** — a productised, automated, fixed-price, self-serve SaaS tool, not personal consultancy. Please confirm 44AD (6%) applies and that this is defensible, and advise how to document it (invoice wording, ToS).

2. **RCM on Anthropic (foreign SaaS input).** Please confirm the reverse-charge self-invoicing + ITC reclaim mechanism, so we pay the 18% IGST *and* take the credit (net-neutral) rather than incurring an uncredited liability.

3. **Tax-audit threshold (44AB).** With the new line added, will combined turnover approach the audit limit? Confirm the limit for our case (₹1 cr / ₹10 cr digital) and the 44AD turnover ceiling (₹2 cr / ₹3 cr digital).

4. **Slab impact.** Adding this income stacks on the proprietor's existing income. Please confirm the marginal slab it will be taxed at and flag if/when it would cross into 30%.

5. **Wallet recharge = advance for a defined service (GST due at recharge), not a "voucher".**
   Please confirm we treat each recharge as an **advance for a defined taxable service** — so GST is due at receipt (recharge) and we invoice per recharge — and that this is *not* caught by the voucher clarification (Circular 243/2024-GST) that would defer GST to redemption. Also confirm the **10% platform fee is part of the same taxable value** (one supply, one 18% rate, GST on the combined amount), and that unused/refunded wallet credit is handled via **credit note** (reducing turnover).

## 4. Key facts for your assessment
- Receipts are **~100% digital** (no cash) → qualifies for the 6% rate and the higher 44AD/44AB digital thresholds.
- Real gross margin is high (~75%), but we intend to rely on the **44AD deemed 6%** rather than itemised profit — please confirm this is the more efficient and compliant route given the turnover.
- We will keep an internal management P&L regardless; the question is only the **tax** treatment.
- GST (normal, with ITC) and income-tax presumptive (44AD) are intended to run **in parallel** — please confirm these two are independent and compatible (i.e. 44AD does **not** force GST composition).

## 5. What we'd like back
- Written confirmation of the **44AD "business"** position (and documentation guidance).
- Confirmation of the **RCM-on-Anthropic** process and any monthly filing impact.
- The **turnover thresholds** that, if crossed, change anything (audit, 44AD eligibility, slab).
- Your estimate of the **extra compliance fee** for adding this line.

---

### Worked example (one recharge — the actual billing flow)
Customer recharges **₹5,000** of wallet credit:

| Line | Amount |
|---|---|
| Wallet credit (spendable) | ₹5,000.00 |
| Platform fee (10%) | ₹500.00 |
| **Taxable value** | **₹5,500.00** |
| Output GST @ 18% | ₹990.00 |
| **Customer pays (card charge)** | **₹6,490.00** |

- **One GST tax invoice issued at recharge**: taxable value ₹5,500, GST ₹990. A registered customer reclaims the ₹990 as ITC.
- **Fixes then draw down the ₹5,000** at per-use prices — **no further GST per fix** (already taxed at recharge).
- **Income-tax turnover = ₹5,500** (GST-exclusive; the ₹990 is a pass-through, not revenue). Under 44AD, deemed profit = 6% × ₹5,500 ≈ **₹330**, taxed at slab — **not** the real margin. COGS (Anthropic/hosting) is **not** deducted under presumptive.
- **Input side (per fix consumed):** at COGS ~$1.00 (≈ ₹90), Anthropic bills ₹90 + 18% RCM IGST ₹16.20 → the ₹16.20 is reclaimable ITC that nets against output GST.

*Note: figures illustrative; GST is a pass-through and does not enter the income-tax P&L. The taxable event is the recharge, not the individual fix.*
