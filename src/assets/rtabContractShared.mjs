// Environment-neutral RTAB contract serialization.
//
// This module deliberately contains NO cryptography and NO Node-only APIs.
// Both the Node generator (scripts/asset-contract.mjs) and the browser loader
// (src/assets/rtabRuntimeLoader.ts) import the same canonicalization rules so
// that the generation ID computed at build time and the generation ID
// reconstructed at runtime are produced by one implementation.

export const MANIFEST_SCHEMA_VERSION = '1.3';
export const RUNTIME_CONTRACT_SCHEMA_VERSION = '1';

// Content-addressed bundle runtime URL convention.
// /assets/bundles/{bundleId}.{fullSha256}.bin
export const BUNDLE_URL_PATTERN = /^\/assets\/bundles\/([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-f0-9]{64})\.bin$/;
export const BUNDLE_URL_PREFIX = '/assets/bundles/';

export function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

// Deterministic JSON-ish canonicalization. Object keys are sorted, arrays are
// preserved in place (callers are responsible for pre-sorting semantic arrays),
// and values are serialized with JSON.stringify. This is the single source of
// truth for the generation-ID input on both sides of the build boundary.
export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function canonicalString(value) {
    return canonical(value);
}

// Build the canonical generation-ID input from manifest + contract data.
// `approvals` may be a Map (Node) or a plain object (browser imported contract).
export function canonicalizeGenerationInput({ assets, bundles, approvals, placements }) {
    const approvalEntries = approvals instanceof Map
        ? [...approvals.entries()]
        : Object.entries(approvals);
    return {
        runtimeContractSchemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
        manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
        assets: [...assets].sort((a, b) => compareText(a.assetId, b.assetId)),
        approvedPlanetSourceSha256: Object.fromEntries(
            approvalEntries.sort(([a], [b]) => compareText(a, b))
        ),
        bundles: [...bundles].sort((a, b) => compareText(a.bundleId, b.bundleId)),
        activePlanetPlacements: [...placements].sort((a, b) => compareText(a.slot, b.slot))
    };
}

// Compute the generation ID from a canonicalized input using an
// environment-supplied SHA-256 over the UTF-8 serialized input string.
// Node passes a sync hash; the browser passes an async Web Crypto hash.
export function computeGenerationId(input, hashString) {
    const serialized = canonicalString(input);
    return hashString(serialized);
}

// Parse a content-addressed bundle URL, returning { bundleId, digest } or null.
export function parseBundleUrl(bundleFile) {
    const match = BUNDLE_URL_PATTERN.exec(bundleFile);
    if (!match) return null;
    return { bundleId: match[1], digest: match[2] };
}
