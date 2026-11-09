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

## Phase 3B.3 Stage A — Folder-derived packaging

The one-shot packager derives category membership from immediate subdirectories of `private/assets/` and recursively includes registered files within each category. The current outputs are `ships.bin`, `components.bin`, `turrets-platforms.bin`, and `planets.bin`; nested source folders do not create additional bundles. The registry owns asset identity and runtime metadata, while folder names alone determine bundle membership.

Registry schema 1.1 and generated manifest schema 1.1 are independent from the unchanged RTAB 1.0 binary format. The registry contains the 31 existing SVG assets and only three approved planet PNGs (`Map-111.png`, `Map-122.png`, and `Map-692.png`); `Map-111-2.png` and `Map-122-2.png` remain public, unregistered, and outside private bundles. The generated Phaser SVG manifest remains SVG-only with 31 entries, and runtime texture keys and loading behavior are unchanged.

PNG validation accepts only non-interlaced RGBA8 images using compression and filter method 0, with dimensions up to 4096×4096 and a maximum compressed file size of 8 MiB (32 MiB aggregate). It independently limits decoded pixel bytes to 64 MiB per image and 256 MiB aggregate, and inflated scanline bytes to 64 MiB + 4096 bytes per image and 257 MiB aggregate. The validator checks chunk ordering and CRCs, requires one fully consumed zlib stream across consecutive IDAT chunks, bounds streaming decompression to the exact IHDR-derived scanline length, and validates every scanline filter byte. PNG payload bytes are preserved; the packager does not re-encode images.

Preparation uses an exclusive process lock and an append-only JSONL transaction journal. Each checksummed record carries the transaction ID and next sequence number; every ordinary output filesystem operation is preceded by a flushed intent and followed by a flushed completion. Lock creation/removal and journal creation/removal are transaction-control lifecycle operations and are not recursively recorded inside the journal they control. A committed-state record explicitly marks the new manifest as committed. Recovery runs only after exclusive lock acquisition, validates the entire journal and actual file hashes, then completes a validated commit or rolls back verified prior outputs. If recovery finds a durable `rolled-back` state, it re-verifies all prior output hashes and confirms temporary/backup artifacts are absent before removing the journal; it never repeats the rollback state transition. Malformed, truncated, or ambiguous journals and unexpected artifacts remain untouched for manual inspection.

An existing lock is never removed automatically, including when its PID appears inactive. The `processStartIdentity` written by the current implementation is a Linux `/proc` start-tick identity where available; the Windows fallback, `estimated-unix-ms`, is only an estimate derived from process uptime and is advisory, not an OS-native process creation identity. To clear a stale lock, stop all asset preparation processes, inspect the lock JSON, and independently verify the owner and process start using the operating system. On Windows, inspect `Get-Process -Id <pid> -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path` and `Get-CimInstance Win32_Process -Filter "ProcessId = <pid>" | Select-Object ProcessId,CommandLine,CreationDate`; compare the executable, command line, and creation time with the lock metadata and confirm no preparation process is active. On Linux, compare `processStartIdentity` with `/proc/<pid>/stat` start ticks. Hostname, PID, age, or the Windows estimate alone is not proof of staleness. Only after an operator confirms the owner is no longer active, remove that exact file from the repository root with `Remove-Item -LiteralPath .\\private\\.asset-package.lock` (or the platform's equivalent); never remove journal or bundle artifacts as part of lock cleanup. If the owner cannot be verified or the identity is ambiguous, preserve the lock and escalate rather than retrying preparation. On clean clones without `private/`, validation checks for transaction artifacts without recovering or modifying them.

Stage A does not add a filesystem listener, runtime hot reload, mod discovery/loading, Phaser bundle loading, or Phase 3C behavior.