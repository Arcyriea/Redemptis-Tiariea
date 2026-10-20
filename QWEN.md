---
category: build_configuration
keywords:
  - Phaser
  - game engine
  - Redemptis-Tiariea
description: "Phaser version and compatibility rules for Redemptis-Tiariea"
type: feedback
---

- Check the project's `package.json` and lockfile to determine the installed Phaser version before writing or modifying Phaser code.
- The current declared dependency is `phaser: ^4.2.1`. Verify the installed version rather than assuming it is exactly 4.2.1.
- Prefer APIs compatible with the installed version. Verify uncertain APIs against installed TypeScript definitions or version-matched documentation.
- Do not blindly apply Phaser 3 examples to Phaser 4.