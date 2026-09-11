# X-Agent

**Agent-native architecture** for upgrading, adapting, and operating existing systems with AI — safely, through schema-driven verbs and human confirmation.

This monorepo contains:

| 主 / 支 | Path | Role | Docs |
|---|---|---|---|
| **主** | [`packages/core/`](./packages/core/) | **X-Agent framework** — `@x-agent/core` | [`packages/core/*.md`](./packages/core/README.md) |
| **支** | [`apps/agent-erp/`](./apps/agent-erp/) | **Agent_ERP** reference app (order → shipment PoC) | [`HANDOVER/`](./HANDOVER/README.md) |

**Governance (2026-09-11)** — same `main` branch, split by directory + docs, not by Git branch:

- Change **framework / protocol** → `packages/core/` + root `README.md`; do **not** put framework spec in `HANDOVER/`.
- Change **ERP app / verbs / eval** → `apps/agent-erp/` + `HANDOVER/`.

> **Naming**: **X-Agent** = product / architecture. **`x-agent`** = JSON Schema extension field (lowercase, unchanged).  
> GitHub: [`EnglandTong/X-Agent`](https://github.com/EnglandTong/X-Agent) (renamed from `Agent_ERP`).

## Reference app demo

Drive business actions with a single sentence. Record every action in immutable tiles.

```
User says at the bottom: 「Get Zhang San 120 units of A-100, due next Wednesday」
   → system detects intent (verb), extracts raw-phrase info (slots),
     resolves it into concrete data (customer ID / date / quantity)
   → prints a confirmation tile on the canvas → human confirms
   → persisted → tile frozen forever
```

## Quick start (agent-erp)

```bash
npm install          # workspace root — installs @x-agent/core + agent-erp
npm run setup        # prisma client + schema + seed (agent-erp)
npm run build
npm run serve        # http://localhost:3001
```

Windows: double-click [`Start.bat`](./Start.bat) (installs from repo root, runs `apps/agent-erp`).

Fill the model key: in-app gear icon → cloud model → paste key → save & test
(see [07_OPS.md](./HANDOVER/07_OPS.md)).

## Taking over development?

**Framework protocol**: [`packages/core/00_MANIFEST.md`](./packages/core/00_MANIFEST.md) · [`packages/core/01_OBSERVATION.md`](./packages/core/01_OBSERVATION.md)

**Reference app**: **[HANDOVER/00_START_HERE.md](./HANDOVER/00_START_HERE.md)** — read `00 → 01 → 02 → 03 → 04`; roadmap **[14_MASTER_PLAN.md](./HANDOVER/14_MASTER_PLAN.md)**; read **`12`** before coding.

| File | Contents |
|---|---|
| [00_START_HERE.md](./HANDOVER/00_START_HERE.md) | Status snapshot, five red lines, next steps |
| [02_ARCHITECTURE.md](./HANDOVER/02_ARCHITECTURE.md) | Five-layer architecture, x-agent protocol, data model |
| [03_VERBS.md](./HANDOVER/03_VERBS.md) | Verb specs, business rules, change-order mechanism |
| [12_HANDOFF.md](./HANDOVER/12_HANDOFF.md) | Dispatch list, red lines, parallel discipline |

## Repository

GitHub: **`EnglandTong/X-Agent`** (renamed from `Agent_ERP`; old URLs redirect).
