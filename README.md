# LuckyToken

LuckyToken requires Node.js 22.19 or newer. The root project pins the Pi public
runtime contract used by the production path; the checked-in `pi-agent/` tree
is reference material.

Install dependencies from a clean checkout without running dependency lifecycle
scripts:

```powershell
npm ci --ignore-scripts
```

Validation commands:

```powershell
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run build
```

The integration suite uses an injected fixture `fetch` implementation. It does
not call the real CommandCode service or read `CommandcodeAPIKey.txt`.
