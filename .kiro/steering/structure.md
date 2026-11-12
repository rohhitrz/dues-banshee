---
inclusion: always
---
# Structure

```
apps/web/                 Next.js app: dashboard, séance screen, landing, API routes
  app/(app)/graveyard     Dashboard
  app/(app)/debtor/[id]   Séance (escalation timeline)
  app/(site)/             Landing page (3D hero adapted from meridian)
  lib/three/              Stage, SceneCanvas, NOISE_GLSL (adapted from meridian, disclosed)
packages/engine/          Pure legal + money logic (due dates, interest, tax bomb) + fast-check tests
packages/agent/           Escalation ladder, tools, prompts, guardrails
packages/voice/           VoiceProvider, buyer-call flow, owner-command intents
evals/                    Labelled fixtures + runner
.kiro/                    steering, specs, hooks, agents, settings/mcp.json (committed)
```

- Kebab-case file names; one spec folder per feature in `.kiro/specs/<feature>/`.
- The Crew app lives in a **separate repo**: `dues-banshee-crew`.
