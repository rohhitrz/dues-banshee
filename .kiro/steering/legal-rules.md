---
inclusion: fileMatch
fileMatchPattern: ["packages/engine/**", "packages/agent/**", "evals/**"]
---
# Legal rules (India) — cite by ID

Verify against current law before launch. These are reminders a supplier sends to its own buyers, not legal advice.

| ID | Rule | Source |
|---|---|---|
| `MSMED-15` | Buyer must pay a micro/small supplier by the agreed date, which can't exceed **45 days** from acceptance. With no agreement, the limit is **15 days**. | MSMED Act 2006, s.15 |
| `MSMED-16` | Late payment carries **compound interest with monthly rests at 3× the RBI bank rate**. | MSMED Act 2006, s.16 |
| `MSMED-18` | Supplier may refer the dispute to the MSE Facilitation Council (MSME Samadhaan portal). | MSMED Act 2006, s.18 |
| `IT-43BH` | Amounts owed to micro/small suppliers beyond the s.15 limit are deductible for the buyer **only in the year actually paid**. If unpaid by **31 March**, the buyer loses the deduction for that year. | Income-tax Act 1961, s.43B(h); Income-tax Act 2025, s.37(2)(g) |

## Config (not hard-coded)
- `RBI_BANK_RATE` (e.g. 5.75% → statutory rate 17.25% p.a.); load from config with an "as of" date.
- Supplier must be a registered micro/small enterprise (Udyam). Store the Udyam number and show it on notices.

## Agent behaviour
- Only state a legal consequence if its rule ID applies to the invoice's facts.
- Phrase as information ("as per MSMED s.16…"), never as a threat.
- Note: the MSMED (Amendment) Bill 2026 is pending in the Lok Sabha. Flag this in the UI's "rules as of" note.
