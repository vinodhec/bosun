# Property Sourcing Relay — Sequence (vet-before-enrich)

The metered sourcing lane (`functions/handlers/runSourcingJobs.js`, 2-hourly cron). The design
principle is **vet cheaply, then pay**: every free gate (URL filter, dedup, coarse SERP date,
Gemini relevance on the free snippet) runs *before* the paid Facebook-post scrape, so only genuine,
in-window listings ever cost money to enrich.

```mermaid
sequenceDiagram
  participant Cron as runSourcingJobs (2h cron)
  participant SERP as Apify Google SERP
  participant FS as Firestore (sourcingSeen)
  participant Gem as Gemini classify
  participant FB as Apify FB scraper 💰PAID
  participant Hook as Org webhook
  participant W as Org wallet

  Note over Cron,SERP: per query in the demand matrix
  Cron->>SERP: fetch (site:facebook.com … tbs=last N months)
  SERP-->>Cron: results {url, title, snippet, lastUpdated}

  Cron->>Cron: isIndividualPost → drop group/page ROOTS
  Cron->>Cron: dedup within run (listingKey)
  Cron->>FS: getAll seen keys
  FS-->>Cron: drop already-relayed / dead links

  rect rgb(228,244,228)
  Note over Cron,Gem: FREE gates — run BEFORE paying
  Cron->>Cron: 3a SERP-date skip — drop confidently-old<br/>(fail-open, 1-month grace)
  Cron->>Gem: 3b classify on the free SERP snippet (per prospect)
  Gem-->>Cron: keep / off-target (fail-open)
  Cron->>Cron: drop off-target · trim to cap × 2
  end

  Cron->>FB: 3c enrich SURVIVORS ONLY 💰
  FB-->>Cron: full text, phone, images, authoritative postedAt

  Cron->>Cron: 3d authoritative FB-date recency drop → markDead
  Cron->>Cron: 3e per-intent freshness (rent vs sale) + stale-fallback

  loop each surviving lead
    Cron->>Hook: HMAC-signed relay
    Hook-->>Cron: 2xx
    Cron->>FS: mark seen (only on 2xx)
  end
  Cron->>W: one TXN debit for the batch (~₹2/lead)
  Cron->>FS: flushDead — enriched-but-dropped never re-enriched
```

## What changed vs the old flow

Previously the two green FREE gates ran *after* the 💰 enrich step: every fetched post was scraped,
then ~37% were discarded for being too old and ~29% for being off-target — **~3.7 paid scrapes per
relayed lead**. Moving both gates ahead of enrichment means only vetted, in-window listings hit the
paid scraper, targeting **~1.5–2 scrapes per lead** (cost/lead ~₹3.6 → ~₹1.8–2.2).

## The two date gates (why there are two)

| Gate | Source | Cost | Role |
|------|--------|------|------|
| **3a SERP-date skip** | Google's `lastUpdated` (present ~69% of posts) | free | Skip confidently-old posts before paying. Coarse (Google's last-seen-update, not the post date), so fail-open with a 1-month grace. |
| **3d FB-date drop** | FB scraper's authoritative `postedAt` | already paid | The real recency gate. Catches what 3a under-caught (the ~31% dateless posts + borderline). Marks stale posts dead so they're never re-enriched. |

## Log lines to watch (per target, one cron run)

- `serp-stale-skip {dropped, kept}` — free kills by the SERP date
- `classify {pool, kept}` — relevance gate (now pre-enrichment)
- `images {enriched}` — the **paid** scrape count (should be much lower now)
- `stale-drop {dropped}` — residual: what the cheap SERP date under-caught
- `intent-stale-drop {dropped, readmitted}` — per-intent freshness
- `done {relayed, amountInr}` — relayed + wallet debit

**Health ratio:** `enriched ÷ relayed` — was **3.7**, target **~1.5–2**.
