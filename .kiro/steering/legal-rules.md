---
inclusion: fileMatch
fileMatchPattern: ["packages/engine/**", "packages/agent/**", "evals/**"]
---
# Legal rules (India) — cite by ID

Verify against current law before launch. These are reminders a supplier sends to its own buyers, not legal advice.

| ID | Rule | Source |
|---|---|---|
| `MSMED-15` | Buyer must pay a micro/small supplier by the agreed date, which can't exceed **45 days** from acceptance or deemed acceptance. With no written agreement, the limit is **15 days**. | MSMED Act 2006, s.15 |
| `MSMED-16` | Late payment carries **compound interest with monthly rests at 3× the RBI bank rate**, from the day after the due date until payment. | MSMED Act 2006, s.16 |
| `MSMED-18` | Supplier may refer the dispute to the MSE Facilitation Council. New claims are filed on the MSME ODR portal (see `MSMED-ODR`). | MSMED Act 2006, s.18 |
| `IT-43BH` | If a micro/small supplier is paid after the s.15 due date, the buyer can deduct the amount **only in the year actually paid**. The deadline to keep the deduction in the purchase year is the **later of 31 March and the s.15 due date**. The return-filing grace period does not apply. | Income-tax Act 1961, s.43B(h); Income-tax Act 2025, s.37(2)(g) |
| `MSMED-SCOPE` | Delayed-payment rules (s.15–18) and IT-43BH apply only to Udyam-registered micro/small suppliers in manufacturing or services. Wholesale/retail traders are excluded (benefits limited to priority sector lending, MoMSME OM 2 Jul 2021). Medium and unregistered suppliers are excluded. Registration after the contract: law unsettled (Silpi 2021, Mahakali 2023 vs NBCC 2025 referral) — flag, don't exclude. | MSMED Act s.2(n); MoMSME OM 02.07.2021 |
| `MSMED-ODR` | New delayed-payment claims are filed on the MSME ODR portal (odr.msme.gov.in), which replaced Samadhaan for fresh applications. | MoMSME |

## Config (not hard-coded)
- `RBI_BANK_RATE` = 575 bps (5.75%) as of 2026-10-07 (repo 5.50% + 25 bps) → statutory rate 17.25% p.a. Load from config with its "as of" date. Re-check after the 4 Dec 2026 MPC.
- Supplier must be Udyam-registered as micro/small in manufacturing or services. Store the Udyam number and show it on notices.

## Agent behaviour
- Only state a legal consequence if its rule ID applies to the invoice's facts.
- State the consequence as information; the Basis line cites the section. Never write section numbers in message text. Never phrase it as a threat.
- If an invoice carries the `registered_after_supply` caveat, say the claim may be contested; don't assert it as certain.
- Note: the MSMED (Amendment) Act 2026 (assent 13 Aug 2026) changes dispute resolution and penalties once notified; it does not change s.15 or s.16. Show "rules as of <date>" in the UI.