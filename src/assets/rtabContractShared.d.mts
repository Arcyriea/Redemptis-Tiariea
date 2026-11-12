export const MANIFEST_SCHEMA_VERSION: string;
export const RUNTIME_CONTRACT_SCHEMA_VERSION: string;
export const BUNDLE_URL_PATTERN: RegExp;
export const BUNDLE_URL_PREFIX: string;

export interface GenerationPlacement {
    slot: string;
    order?: number;
    textureKey?: string;
}

export function compareText(left: string, right: string): number;
export function canonical(value: unknown): string;
export function canonicalString(value: unknown): string;
export function canonicalizeGenerationInput(input: {
    assets: readonly object[];
    bundles: readonly object[];
    approvals: Map<string, string> | Readonly<Record<string, string>>;
    placements: readonly GenerationPlacement[];
}): {
    runtimeContractSchemaVersion: string;
    manifestSchemaVersion: string;
    assets: object[];
    approvedPlanetSourceSha256: Record<string, string>;
    bundles: object[];
    activePlanetPlacements: GenerationPlacement[];
};
export function computeGenerationId<T extends string | Promise<string>>(
    input: unknown,
    hashString: (serialized: string) => T
): T;
export function parseBundleUrl(bundleFile: string): { bundleId: string; digest: string } | null;
