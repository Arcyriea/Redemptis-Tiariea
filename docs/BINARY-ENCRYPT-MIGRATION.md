#: 1
Phase: Private source mapping
Depends on: —
Key deliverable: Multi-root source mapping spec; shared
ASSET_SOURCE_ROOTS constant preserving logical paths and
runtime URLs
────────────────────────────────────────
#: 2
Phase: One-category migration & verification
Depends on: 1
Key deliverable: Ships/ migrated to private/;
public/Ships/*.svg retained; verified identical
keys/aliases/rendering
────────────────────────────────────────
#: 3
Phase: Versioned .bin packaging format
Depends on: 2
Key deliverable: scripts/package-assets.mjs; committed .bin +
authoritative asset-manifest.json
────────────────────────────────────────
#: 4
Phase: Fingerprinting & integrity validation
Depends on: 3
Key deliverable: SHA-256 per asset + per bundle; validate on
load and on predev/prebuild
────────────────────────────────────────
#: 5
Phase: Incremental bundle rebuilding
Depends on: 4
Key deliverable: Fingerprint-diff; only changed categories
rebuild; atomic temp→rename
────────────────────────────────────────
#: 6
Phase: Development watcher
Depends on: 5
Key deliverable: scripts/watch-assets.mjs; single-flight;
watches private/ only, not generated output
────────────────────────────────────────
#: 7
Phase: predev/prebuild integration
Depends on: 4, 5
Key deliverable: Source-available → generate;
source-unavailable → validate only; fail clear on
missing/invalid
────────────────────────────────────────
#: 8
Phase: Bundle-based runtime loading
Depends on: 3, 7
Key deliverable: src/assets/AssetProvider.ts
(BundleAssetProvider / SourceAssetProvider); bootstrap decode
 before BootScene
────────────────────────────────────────
#: 9
Phase: Remaining category migrations
Depends on: 8
Key deliverable: Components/ → Turrets-Platforms/ →
favicon.svg/icons.svg; remove old public/ SVGs per category
after verification
────────────────────────────────────────
#: 10
Phase: Clean-clone & production-output verification
Depends on: 7, 8
Key deliverable: scripts/verify-clean-clone.mjs; dist/
artwork-leak scan; git check-ignore private/


Test and verification criteria

- Phase 1: node scripts/generate-public-svg-manifest.mjs from private/ produces byte-identical keys/aliases to the current public/ run; node scripts/add-svg-copyright.mjs --dry-run reports 0 malformed after the isMalformed fix; git check-ignore private/assets/Ships/human-dreadnought.svg succeeds; SHA-256 of each private/ file equals its public/ counterpart.
- Phase 2: node scripts/package-assets.mjs produces ships.bin + asset-manifest.json; re-run is a no-op (fingerprints unchanged); removing one source SVG fails with a clear "missing asset" error; corrupting a .bin is detected by fingerprint mismatch on validate; existing npm test unchanged (120/2 baseline).
- Phase 3–4: strict saxes parse rejects a malformed SVG before bundling; fingerprint record is present for every asset and matches on re-validation.
- Phase 5: editing one private/assets/Ships/*.svg rebuilds only ships.bin within ~2s; no partial bundle observable (temp-file + rename).
- Phase 7: npm run predev succeeds with private/ present (generates) and with private/ absent (validates committed bundles only, fails clearly if a bundle is missing).
- Phase 8: game boots from committed .bin alone; public-svg-manifest.test.ts still passes; new test asserts provider resolves the same keys including legacy aliases central-hull, human-dreadnought, alien-interceptor.
- Phase 9: per-category git rm public/assets/<cat>/*.svg after verification; build still works from .bin.
- Phase 10: simulated clean clone runs npm run dev/build from committed bundles only; dist/ scan finds zero uncompiled SVG source; git check-ignore private/ succeeds.