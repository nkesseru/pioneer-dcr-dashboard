# PioneerOps Operator Certification Registry

The canonical, authoritative list of all certified PioneerOps Operators. Every certification, renewal, demotion, and revocation is recorded here.

> **Custodianship:** Academy lead. Registry entries are append-only — corrections add new entries; original entries are never modified.
>
> **Authority:** [Operator Certification Framework](./operator-certification-framework.md). Where the registry and the framework diverge, the framework governs and the registry is corrected.

---

## Lineage ID format

Every certified Operator carries a permanent Lineage ID:

```
POPS-OP-{Tier}-{YYYY}-{LineageID}
```

Where:

- `POPS-OP` — PioneerOps Operator (constant prefix)
- `Tier` — current tier: `I` / `II` / `III` / `EA`
- `YYYY` — year of **original** certification (not current tier)
- `LineageID` — 4-digit sequential number, assigned at original certification, **permanent across tier transitions**

### Examples

| ID | Meaning |
|---|---|
| `POPS-OP-I-2026-0001` | The first Operator I ever certified. Year 2026. |
| `POPS-OP-II-2026-0001` | The same person, promoted to Operator II. Same year, same lineage. |
| `POPS-OP-III-2027-0001` | The same person, promoted to Operator III in 2027. Year of original cert remains 2026. |
| `POPS-OP-EA-2029-0001` | The same person, promoted to Executive Advisor. |

### Lineage Continuity Rules

- The `LineageID` portion is **assigned at first certification** and never changes.
- The `Tier` portion **updates** on each tier transition.
- The `YYYY` portion reflects the **year of original certification**, NOT the current tier's promotion year.
- On revocation, the Lineage ID is **retired** with a reason — never reassigned to a new Operator.

---

## How to read this registry

The registry has three sections:

1. **Active certifications** — current Operators in good standing
2. **Historical certifications** — Operators who have since been demoted, revoked, or who have not renewed
3. **Retired Lineage IDs** — IDs that will never be reassigned, with reason

The registry is updated by the Academy lead at:
- Every initial certification
- Every renewal decision
- Every demotion or revocation
- Annually for full review

---

## Section 1 — Active Certifications

Current certified Operators in good standing.

| Lineage ID | Name | Tier | First certified | Current tier since | Next renewal | Mentor lineage |
|---|---|---|---|---|---|---|
| _(none yet — registry initialized 2026-06-11)_ | | | | | | |

> When the first Operator is certified, this section becomes the authoritative active roster.

### Field definitions

| Field | Definition |
|---|---|
| **Lineage ID** | Full ID per format above |
| **Name** | Operator's full legal name |
| **Tier** | Current tier: I / II / III / EA |
| **First certified** | Date of original certification (YYYY-MM-DD) |
| **Current tier since** | Date the Operator was promoted to current tier |
| **Next renewal** | Date renewal evidence is due |
| **Mentor lineage** | Lineage IDs of the Operators who mentored this candidate to their current tier (comma-separated) |

---

## Section 2 — Historical Certifications

Operators who are no longer at their last certified tier — through demotion, non-renewal, or departure.

| Lineage ID | Name | Last tier | Period active | Reason for status change | Date of change |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |

### Status change reasons

| Reason | Meaning |
|---|---|
| **Demoted** | Tier reduced per Framework Section 9. Operator may re-promote per process. |
| **Non-renewed** | Renewal evidence not submitted or not sufficient. Credential lapses; Operator may re-certify at lower tier. |
| **Left Pioneer** | Operator departed. Credential continues if Operator submits renewal evidence per Framework Section 13.3 (portability). |
| **Voluntary downgrade** | Operator requested reduction (e.g., role change). |

> Note on portability: certifications travel with the Operator. An Operator who leaves Pioneer for another company keeps their credential, subject to renewal obligations.

---

## Section 3 — Retired Lineage IDs

Lineage IDs that will never be reassigned. Always tied to a reason.

| Lineage ID | Original name (redacted if requested) | Date retired | Reason |
|---|---|---|---|
| _(none yet)_ | | | |

### Why retire IDs

Per Framework Section 12 ("The Certification Identifier System"), retiring rather than reassigning IDs preserves the integrity of the lineage system. A retired ID still appears in historical records (e.g., as the mentor lineage of an active Operator); reassigning would create ambiguity.

---

## The Lineage Tree

As the registry grows, mentor lineages form a tree showing who trained whom. The tree is a working artifact — it shows the doctrine's transmission across generations of Operators.

> When at least 3 Operators are certified, this section will populate with the mentor lineage diagram (ASCII or rendered).

```
   _(empty — registry initialized 2026-06-11)_
```

### Properties of a healthy lineage tree

| Property | What it means |
|---|---|
| **Wide root** | Multiple founding Operators, not a single point of doctrine origin. Tests doctrine portability. |
| **Generational depth** | Mentors who graduate mentors who graduate mentors. Tests doctrine durability. |
| **Cross-pollination** | Operators mentored by multiple seniors. Tests doctrine consistency across mentors. |
| **Pruned branches** | Demoted or revoked Operators visible as truncated branches. Tests the framework's integrity enforcement. |

A tree without pruning is suspicious. A tree without depth is young. A tree with breadth + depth + visible pruning is mature.

---

## Registry Operations Log

Append-only log of every registry change.

| Date | Operation | Lineage ID affected | Performed by | Reason |
|---|---|---|---|---|
| 2026-06-11 | Registry initialized | n/a | Academy lead | Framework v1 published; registry instantiated |

> Every future operation (certify, renew, demote, decertify, retire) appends a row here.

---

## Public Verification

Per the framework's Vision: as the credential gains market value, third parties should be able to verify an Operator's credential without contacting Pioneer directly.

### v1 — Internal verification

Internal Pioneer / Academy contacts the Academy lead. The Academy lead confirms or denies.

### v2 — Public verification API (future)

A read-only endpoint where any party can submit a Lineage ID and receive:
- Current tier
- First certification date
- Current tier since date
- Active / historical status
- (Operator's name only if Operator consented to public disclosure)

This is **not v1 scope.** It is in the framework's Open Questions (Section 15). It is named here so the v1 registry's data model anticipates it.

### v3 — Industry credential body (future)

Eventual external credentialing organization that maintains the registry independently of Pioneer. Per Thesis Section 19, the Academy's long arc is from training arm → standards body → profession-defining institution. The registry is the seed of the standards body.

---

## Amendment Process

Registry format amendments follow the framework amendment process:

1. **Evidence first** — a registry need surfaces (e.g., a missing field, an ambiguous status)
2. **Diagnosed** — what specific gap exists
3. **Amended visibly** — registry format updated, version noted in the log
4. **Verified** — next certification cycle uses the new format

Registry **entries** are append-only and never amended. Registry **format** can be amended with all existing entries migrated forward.

---

| Document version | 1 |
|---|---|
| Last updated | 2026-06-11 |
| Custodianship | Academy lead |
| Authority | [Operator Certification Framework](./operator-certification-framework.md) |
