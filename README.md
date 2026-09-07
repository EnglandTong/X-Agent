# AGT-ERP · Agent-Driven ERP (PoC)

Drive business actions with a single sentence. Record every action in immutable tiles.

```
User says at the bottom: 「Get Zhang San 120 units of A-100, due next Wednesday」
   → system detects intent (verb), extracts raw-phrase info (slots),
     resolves it into concrete data (customer ID / date / quantity)
   → prints a confirmation tile on the canvas → human confirms
   → persisted → tile frozen forever
```

> **Note** — internal docs under [`HANDOVER/`](./HANDOVER/00_START_HERE.md) are written in Chinese.
> They are the **single source of truth** for architecture, verb specs, decisions and test logs.

## 👉 Taking over development? Start here

**[HANDOVER/00_START_HERE.md](./HANDOVER/00_START_HERE.md)**

The handover docs are self-contained — read `00 → 01 → 02 → 03 → 04` and you can continue without
any chat history. **Read `12` before starting work** (dispatch list: assets to keep / task list /
red lines / parallel discipline).

| File | Contents |
|---|---|
| [00_START_HERE.md](./HANDOVER/00_START_HERE.md) | Status snapshot, five red lines, next steps |
| [01_VISION.md](./HANDOVER/01_VISION.md) | Product philosophy and explicit non-goals |
| [02_ARCHITECTURE.md](./HANDOVER/02_ARCHITECTURE.md) | Five-layer architecture, x-agent protocol, data model |
| [03_VERBS.md](./HANDOVER/03_VERBS.md) | **12 verb** specs, business rules, change-order mechanism |
| [04_DECISIONS.md](./HANDOVER/04_DECISIONS.md) | Decision log (incl. rejected options and owner corrections) |
| [05_TEST_LOG.md](./HANDOVER/05_TEST_LOG.md) | Verified / unverified items with repro commands |
| [06_ROADMAP.md](./HANDOVER/06_ROADMAP.md) | 12-verb landscape, W1 todos, milestones |
| [07_OPS.md](./HANDOVER/07_OPS.md) | Startup, backup, API key config, troubleshooting |
| [08_FILE_TREE.md](./HANDOVER/08_FILE_TREE.md) | Responsibility of every file |
| [09_GLOSSARY.md](./HANDOVER/09_GLOSSARY.md) | Glossary + owner collaboration preferences |
| [10_SESSION_LOG.md](./HANDOVER/10_SESSION_LOG.md) | Discussion history (why it is the way it is) |
| [11_PERSONAL_LEXICON.md](./HANDOVER/11_PERSONAL_LEXICON.md) | Personal lexicon schema + resolve/canvas hook points |
| [**12_HANDOFF.md**](./HANDOVER/12_HANDOFF.md) | **Dispatch list**: assets to keep / T0–T6 tasks / red lines (**read before starting**) |

## Quick start

```bash
cd app
npm install
npm run setup     # prisma client + schema + seed data
npm run build
npm run serve     # http://localhost:3001
```

Fill the model key: in-app gear icon (top-right) → cloud model → paste key → save & test
(see [07_OPS.md](./HANDOVER/07_OPS.md)).

## Current status (2026-09-07, after the T1 real-world run)

| Item | Status |
|---|---|
| Verbs | ✅ **13** landed (sales order → shipment line + `lexicon.remember`) |
| Cloud brain | ✅ `doubao-seed-2.0-lite` (key in `app/.env.local`, never committed) |
| Rules fallback | ✅ silently falls back to rules without a key (verb 96.0% / slot 95.0%) — **works offline** |
| **End-to-end real run** | ✅ **T1 done**: 10 real-world utterances — cloud **9/10**, offline **6/10**, **0 silent bad writes** |
| Human usage traces | ✅ `PersonalLexeme` rows & `Panel` tiles no longer zero (were 0 for a long time) |
| Speech localization | 🟡 **weights in place**: `model.int8.onnx` 228 MB + `tokens.txt` + 24 hotwords (T2 done); CER not yet measured (needs sherpa-onnx runtime) |

**Known gaps** (evidence & repro: [05_TEST_LOG.md](./HANDOVER/05_TEST_LOG.md), section 5):

| # | Gap |
|---|---|
| ~~**G1**~~ | ✅ **fixed**: `lexicon.remember` (13th verb) — 「remember: A is B」 now works end-to-end |
| **G2** | No `price.query`; read-only verbs can **confidently answer the wrong question** (offline mode turned 「how much is a pen」 into an order query) |
| **G3** | Offline rules engine is weaker than the cloud at verb detection (real-world sample: cloud 97.3% vs rules 78.4%) |

Source of truth: GitHub `main` + `HANDOVER/`. The zip/bundle files are cloud-drive snapshots (gitignored).
