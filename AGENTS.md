<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Repo rules

- `packages/shell/src/core` is pure TypeScript: no React, no DOM globals at module scope.
- `packages/shell/src/ui` never imports wagmi or viem.
- `packages/inspector` never imports React or Next.
- Apps in `apps/web/src/apps/*` never import each other; they open each other with `useDesktop().open()`.
- Never commit secrets. `.env*` is ignored; only `.env.example` is tracked.
