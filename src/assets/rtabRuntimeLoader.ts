import { publicSvgTextures } from '../generated/publicSvgManifest';
import { runtimeAssetContract } from '../generated/runtimeAssetContract';
import {
    canonicalizeGenerationInput,
    compareText,
    computeGenerationId,
    parseBundleUrl
} from './rtabContractShared.mjs';

const HEADER_SIZE = 64;
const INDEX_HEADER_SIZE = 28;
const RECORD_SIZE = 72;
const DIGEST_SIZE = 32;
const HEADER_FLAGS = 0x0003;
const UINT32_MAX = 0xffff_ffffn;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLANET_DIMENSIONS = Object.freeze({ width: 2000, height: 1000 });
const PLANET_TEXTURE_KEY_PATTERN = /^planetMap(?:[1-9][0-9]*|[A-Z][A-Za-z0-9]*)$/;

export const APPROVED_PLANET_SHA256: Readonly<Record<string, string>> = runtimeAssetContract.approvedPlanetSourceSha256;

type ContentType = 'SVG' | 'PNG';
type FormatVersion = '1.0' | '1.1';

export interface RuntimeAssetMetadata {
    assetId: string;
    logicalPath: string;
    textureKey: string;
    aliases: readonly string[];
    contentType: ContentType;
    sourceSha256: string;
    bundleId: string;
}

export interface RuntimeBundleMetadata {
    bundleId: string;
    bundleFile: string;
    formatVersion: FormatVersion;
    assetCount: number;
    bundleSha256: string;
}

export interface RuntimeManifest {
    manifestSchemaVersion: '1.3';
    generationId: string;
    activePlanetPlacements: Array<{ slot: string; order: number; textureKey: string }>;
    assets: RuntimeAssetMetadata[];
    bundles: RuntimeBundleMetadata[];
}

export interface PreparedRuntimeAsset {
    asset: RuntimeAssetMetadata;
    image: HTMLImageElement;
}

export interface PreparedRuntimeAssets {
    manifest: RuntimeManifest;
    assets: PreparedRuntimeAsset[];
}

export interface TextureManagerLike {
    exists(key: string): boolean;
    addImage(key: string, image: HTMLImageElement): unknown | null;
    remove(key: string): unknown;
}

export interface DecodedRecord {
    assetId: string;
    bytes: Uint8Array;
    contentType: ContentType;
    asset: RuntimeAssetMetadata;
}

const contractAssets = runtimeAssetContract.assets as readonly RuntimeAssetMetadata[];
const contractById = new Map(contractAssets.map((asset) => [asset.assetId, asset]));
function fail(message: string): never {
    throw new Error(`RTAB runtime preflight: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unsupported or missing properties.`);
    }
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function svgManifestByPath(): Map<string, { key: string; aliases: readonly string[] }> {
    const result = new Map<string, { key: string; aliases: readonly string[] }>();
    for (const entry of publicSvgTextures) {
        if (!entry.url.startsWith('/assets/')) fail(`SVG manifest URL "${entry.url}" is outside /assets/.`);
        const logicalPath = `assets/${decodeURIComponent(entry.url.slice('/assets/'.length))}`;
        if (result.has(logicalPath)) fail(`SVG manifest repeats "${logicalPath}".`);
        result.set(logicalPath, { key: entry.key, aliases: entry.aliases });
    }
    return result;
}

const svgIdentityByPath = svgManifestByPath();

export function assertPlanetFingerprint(logicalPath: string, manifestHash: string, payloadHash?: string): void {
    const approved = APPROVED_PLANET_SHA256[logicalPath];
    if (!approved || manifestHash !== approved) {
        fail(`manifest source fingerprint for planet "${logicalPath}" is not approved.`);
    }
    if (payloadHash !== undefined && payloadHash !== approved) {
        fail(`payload fingerprint for planet "${logicalPath}" is not approved.`);
    }
}

function validateExpectedSvgIdentity(asset: RuntimeAssetMetadata): void {
    const runtime = svgIdentityByPath.get(asset.logicalPath);
    if (!runtime || runtime.key !== asset.textureKey
        || JSON.stringify(runtime.aliases) !== JSON.stringify(asset.aliases)) {
        fail(`registered SVG identity does not match publicSvgManifest for "${asset.assetId}".`);
    }
}

export async function validateRuntimeManifest(
    value: unknown,
    subtle: SubtleCrypto = globalThis.crypto.subtle
): Promise<RuntimeManifest> {
    if (!isRecord(value)) fail('manifest must be an object.');
    exactKeys(value, ['manifestSchemaVersion', 'generationId', 'activePlanetPlacements', 'assets', 'bundles'], 'manifest');
    if (value.manifestSchemaVersion !== '1.3') fail('manifestSchemaVersion must be 1.3.');
    if (runtimeAssetContract.runtimeContractSchemaVersion !== '1'
        || runtimeAssetContract.manifestSchemaVersion !== '1.3') {
        fail('generated runtime contract schema versions are unsupported.');
    }
    if (!Array.isArray(value.assets) || !Array.isArray(value.bundles) || !Array.isArray(value.activePlanetPlacements)) {
        fail('manifest asset, bundle, or active-placement inventory is invalid.');
    }
    if (typeof value.generationId !== 'string' || !SHA256_PATTERN.test(value.generationId)
        || value.assets.length !== contractAssets.length) {
        fail('manifest generation ID or asset inventory count is invalid.');
    }
    const placementSlots = new Set<string>();
    const placementOrders = new Set<number>();
    for (const item of value.activePlanetPlacements) {
        if (!isRecord(item)) fail('active planet placement must be an object.');
        exactKeys(item, ['slot', 'order', 'textureKey'], 'active planet placement');
        if (typeof item.slot !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.slot)
            || !Number.isSafeInteger(item.order) || Number(item.order) < 1
            || typeof item.textureKey !== 'string' || !PLANET_TEXTURE_KEY_PATTERN.test(item.textureKey)
            || placementSlots.has(item.slot) || placementOrders.has(Number(item.order))) {
            fail('active planet placements contain invalid or duplicate slots, orders, or keys.');
        }
        placementSlots.add(item.slot);
        placementOrders.add(Number(item.order));
    }
    const assetsById = new Map<string, RuntimeAssetMetadata>();
    const textureNames = new Set<string>();
    for (const item of value.assets) {
        if (!isRecord(item)) fail('manifest asset must be an object.');
        exactKeys(item, [
            'assetId', 'logicalPath', 'textureKey', 'aliases', 'contentType', 'sourceSha256', 'bundleId'
        ], 'manifest asset');
        const asset = item as unknown as RuntimeAssetMetadata;
        if (typeof asset.assetId !== 'string' || typeof asset.logicalPath !== 'string'
            || typeof asset.textureKey !== 'string' || !isStringArray(asset.aliases)
            || (asset.contentType !== 'SVG' && asset.contentType !== 'PNG')
            || typeof asset.bundleId !== 'string' || !SHA256_PATTERN.test(asset.sourceSha256)) {
            fail('manifest asset contains invalid field values.');
        }
        const expected = contractById.get(asset.assetId);
        if (!expected || asset.logicalPath !== expected.logicalPath
            || asset.textureKey !== expected.textureKey
            || asset.contentType !== expected.contentType
            || asset.bundleId !== expected.bundleId
            || asset.sourceSha256 !== expected.sourceSha256
            || JSON.stringify(asset.aliases) !== JSON.stringify(expected.aliases)) {
            fail(`manifest identity differs from the expected inventory for "${asset.assetId}".`);
        }
        if (assetsById.has(asset.assetId)) fail(`manifest repeats asset ID "${asset.assetId}".`);
        for (const textureName of [asset.textureKey, ...asset.aliases]) {
            if (!textureName || textureNames.has(textureName)) fail(`texture key or alias "${textureName}" is duplicated.`);
            textureNames.add(textureName);
        }
        if (asset.contentType === 'SVG') {
            validateExpectedSvgIdentity(asset);
        } else {
            assertPlanetFingerprint(asset.logicalPath, asset.sourceSha256);
        }
        assetsById.set(asset.assetId, asset);
    }
    if (assetsById.size !== contractAssets.length || contractAssets.some((asset) => !assetsById.has(asset.assetId))) {
        fail('manifest does not exactly cover the generated runtime asset inventory.');
    }

    const expectedBundleAssets = new Map<string, RuntimeAssetMetadata[]>();
    for (const asset of assetsById.values()) {
        expectedBundleAssets.set(asset.bundleId, [...(expectedBundleAssets.get(asset.bundleId) ?? []), asset]);
    }
    const bundlesById = new Map<string, RuntimeBundleMetadata>();
    for (const item of value.bundles) {
        if (!isRecord(item)) fail('manifest bundle must be an object.');
        exactKeys(item, ['bundleId', 'bundleFile', 'formatVersion', 'assetCount', 'bundleSha256'], 'manifest bundle');
        const bundle = item as unknown as RuntimeBundleMetadata;
        if (typeof bundle.bundleId !== 'string' || typeof bundle.bundleFile !== 'string'
            || (bundle.formatVersion !== '1.0' && bundle.formatVersion !== '1.1')
            || !Number.isInteger(bundle.assetCount) || !SHA256_PATTERN.test(bundle.bundleSha256)) {
            fail('manifest bundle contains invalid field values.');
        }
        const matchingAssets = expectedBundleAssets.get(bundle.bundleId);
        const parsedUrl = parseBundleUrl(bundle.bundleFile);
        const expectedFormat: FormatVersion | null = matchingAssets?.some((asset) => asset.contentType === 'PNG') ? '1.1' : '1.0';
        if (!matchingAssets || !parsedUrl || parsedUrl.bundleId !== bundle.bundleId
            || parsedUrl.digest !== bundle.bundleSha256
            || bundle.bundleFile !== `/assets/bundles/${bundle.bundleId}.${bundle.bundleSha256}.bin`
            || bundle.formatVersion !== expectedFormat || bundle.assetCount !== matchingAssets.length) {
            fail(`manifest bundle metadata or content-addressed URL is invalid for "${bundle.bundleId}".`);
        }
        if (bundlesById.has(bundle.bundleId)) fail(`manifest repeats bundle "${bundle.bundleId}".`);
        if (bundle.formatVersion === '1.0' && matchingAssets.some((asset) => asset.contentType !== 'SVG')) {
            fail(`RTAB 1.0 bundle "${bundle.bundleId}" contains a non-SVG asset.`);
        }
        bundlesById.set(bundle.bundleId, bundle);
    }
    if (bundlesById.size !== expectedBundleAssets.size
        || [...expectedBundleAssets.keys()].some((bundleId) => !bundlesById.has(bundleId))) {
        fail('manifest does not exactly cover the derived bundle inventory.');
    }

    const generationInput = canonicalizeGenerationInput({
        assets: value.assets as RuntimeAssetMetadata[],
        bundles: value.bundles as RuntimeBundleMetadata[],
        approvals: runtimeAssetContract.approvedPlanetSourceSha256,
        placements: value.activePlanetPlacements
    });
    const calculatedGenerationId = await computeGenerationId(generationInput, async (serialized: string) => (
        hex(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(serialized))))
    ));
    if (calculatedGenerationId !== value.generationId
        || calculatedGenerationId !== runtimeAssetContract.generationId) {
        fail('manifest generation ID does not match the independently computed runtime contract.');
    }
    const sortPlacements = (entries: readonly unknown[]) => [...entries].sort((left: any, right: any) => compareText(left.slot, right.slot));
    if (JSON.stringify(sortPlacements(value.activePlanetPlacements))
        !== JSON.stringify(sortPlacements(runtimeAssetContract.activePlanetPlacements))) {
        fail('manifest active planet placements differ from the generated runtime contract.');
    }

    return value as unknown as RuntimeManifest;
}

function asSafeNumber(value: bigint, label: string): number {
    if (value < 0n || value > MAX_SAFE_BIGINT) fail(`${label} exceeds the safe integer range.`);
    return Number(value);
}

function asUint32(value: bigint, label: string): void {
    if (value < 0n || value > UINT32_MAX) fail(`${label} exceeds the RTAB v1 uint32 range.`);
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array, subtle: SubtleCrypto): Promise<string> {
    const exactBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return hex(new Uint8Array(await subtle.digest('SHA-256', exactBuffer)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function readU64(view: DataView, offset: number, label: string): bigint {
    if (offset < 0 || offset + 8 > view.byteLength) fail(`${label} is truncated.`);
    return view.getBigUint64(offset, true);
}

export async function validateRtabBundle(
    input: ArrayBuffer | Uint8Array,
    bundle: RuntimeBundleMetadata,
    expectedAssets: readonly RuntimeAssetMetadata[],
    subtle: SubtleCrypto = globalThis.crypto.subtle
): Promise<DecodedRecord[]> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.byteLength < HEADER_SIZE) fail(`bundle "${bundle.bundleId}" is shorter than its header.`);
    if (await sha256(bytes, subtle) !== bundle.bundleSha256) fail(`bundle "${bundle.bundleId}" SHA-256 mismatch.`);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
    if (ascii(0, 4) !== 'RTAB') fail(`bundle "${bundle.bundleId}" has invalid magic.`);
    const versionCode = view.getUint16(4, true);
    const version: FormatVersion | null = versionCode === 0x0100 ? '1.0' : versionCode === 0x0101 ? '1.1' : null;
    if (!version) fail(`bundle "${bundle.bundleId}" has unsupported version 0x${versionCode.toString(16)}.`);
    if (version !== bundle.formatVersion) fail(`bundle "${bundle.bundleId}" version differs from the manifest.`);
    if (view.getUint16(6, true) !== HEADER_FLAGS) fail(`bundle "${bundle.bundleId}" has unsupported header flags.`);
    if (bytes.subarray(32, HEADER_SIZE).some((byte) => byte !== 0)) fail(`bundle "${bundle.bundleId}" reserved header bytes are nonzero.`);

    const payloadOffsetBig = readU64(view, 8, 'payload offset');
    const indexOffsetBig = readU64(view, 16, 'index offset');
    const indexSizeBig = readU64(view, 24, 'index size');
    if (indexOffsetBig !== BigInt(HEADER_SIZE)) fail('index offset must be exactly 64.');
    if (indexOffsetBig + indexSizeBig !== payloadOffsetBig) fail('payload must immediately follow the index.');
    if (indexSizeBig > BigInt(bytes.byteLength) || indexOffsetBig + indexSizeBig > BigInt(bytes.byteLength)) {
        fail('index range exceeds bundle length.');
    }
    if (payloadOffsetBig >= BigInt(bytes.byteLength)) fail('payload section is empty or outside the bundle.');

    const indexOffset = asSafeNumber(indexOffsetBig, 'index offset');
    const indexSize = asSafeNumber(indexSizeBig, 'index size');
    const payloadOffset = asSafeNumber(payloadOffsetBig, 'payload offset');
    if (indexSize < INDEX_HEADER_SIZE + RECORD_SIZE + DIGEST_SIZE) fail('index is too small for one record.');
    const index = bytes.subarray(indexOffset, indexOffset + indexSize);
    if (String.fromCharCode(...index.subarray(0, 4)) !== 'INDX') fail('index has invalid magic.');
    const indexView = new DataView(index.buffer, index.byteOffset, index.byteLength);
    const count = indexView.getUint32(4, true);
    if (count === 0 || count !== expectedAssets.length || count !== bundle.assetCount) {
        fail(`bundle "${bundle.bundleId}" has an incorrect record count.`);
    }
    if (indexView.getUint16(8, true) !== RECORD_SIZE) fail('record size is not 72 bytes.');
    if (indexView.getUint16(10, true) !== 0) fail('index flags must be zero.');

    const stringTableOffsetBig = readU64(indexView, 12, 'string table offset');
    const stringTableSizeBig = readU64(indexView, 20, 'string table size');
    const expectedStringTableOffset = BigInt(INDEX_HEADER_SIZE) + BigInt(count) * BigInt(RECORD_SIZE);
    if (stringTableOffsetBig !== expectedStringTableOffset) fail('string table must immediately follow the record table.');
    asUint32(stringTableSizeBig, 'string table size');
    const expectedIndexSize = expectedStringTableOffset + stringTableSizeBig + BigInt(DIGEST_SIZE);
    if (expectedIndexSize !== indexSizeBig) fail('index size does not match its records, strings, and digest.');
    const digestStart = index.byteLength - DIGEST_SIZE;
    const calculatedIndexDigest = new Uint8Array(await subtle.digest('SHA-256', index.slice(0, digestStart)));
    if (!equalBytes(calculatedIndexDigest, index.subarray(digestStart))) fail('index SHA-256 mismatch.');

    const stringTableOffset = asSafeNumber(stringTableOffsetBig, 'string table offset');
    const stringTableSize = asSafeNumber(stringTableSizeBig, 'string table size');
    const stringTable = index.subarray(stringTableOffset, stringTableOffset + stringTableSize);
    const payload = bytes.subarray(payloadOffset);
    const expectedById = new Map(expectedAssets.map((asset) => [asset.assetId, asset]));
    const ids = new Set<string>();
    const records: DecodedRecord[] = [];
    let expectedStringCursor = 0n;
    let expectedPayloadCursor = 0n;
    let previousId = '';

    for (let recordIndex = 0; recordIndex < count; recordIndex += 1) {
        const recordOffset = INDEX_HEADER_SIZE + recordIndex * RECORD_SIZE;
        if (recordOffset + RECORD_SIZE > digestStart) fail('record table is truncated.');
        const idOffset = BigInt(indexView.getUint32(recordOffset, true));
        const idLength = BigInt(indexView.getUint32(recordOffset + 4, true));
        const assetPayloadOffset = readU64(indexView, recordOffset + 8, 'record payload offset');
        const storedSize = readU64(indexView, recordOffset + 16, 'record stored size');
        const originalSize = readU64(indexView, recordOffset + 24, 'record original size');
        const contentTypeCode = indexView.getUint16(recordOffset + 32, true);
        const compressionMethod = indexView.getUint16(recordOffset + 34, true);
        const entryFlags = indexView.getUint32(recordOffset + 36, true);
        asUint32(idLength, 'asset ID byte length');
        if (idOffset !== expectedStringCursor || idOffset + idLength > stringTableSizeBig) {
            fail('asset ID ranges must be contiguous within the string table.');
        }
        const contentType: ContentType | null = contentTypeCode === 0 ? 'SVG' : contentTypeCode === 1 ? 'PNG' : null;
        if (!contentType || (version === '1.0' && contentType !== 'SVG')) fail('content type is not supported by the RTAB version.');
        if (compressionMethod !== 0) fail('compression method must be NONE.');
        if (entryFlags !== 0) fail('record flags must be zero.');
        if (storedSize === 0n || storedSize !== originalSize || storedSize > UINT32_MAX) fail('record payload size is invalid.');
        if (assetPayloadOffset !== expectedPayloadCursor || assetPayloadOffset + storedSize > BigInt(payload.byteLength)) {
            fail('record payload ranges must be contiguous and within the payload section.');
        }

        const idStart = asSafeNumber(idOffset, 'asset ID offset');
        const idEnd = asSafeNumber(idOffset + idLength, 'asset ID end');
        let assetId: string;
        try {
            assetId = new TextDecoder('utf-8', { fatal: true }).decode(stringTable.subarray(idStart, idEnd));
        } catch {
            fail('asset ID is not valid UTF-8.');
        }
        if (!assetId || ids.has(assetId) || assetId <= previousId) fail(`asset ID "${assetId}" is empty, duplicated, or unsorted.`);
        ids.add(assetId);
        previousId = assetId;
        const asset = expectedById.get(assetId);
        if (!asset) fail(`bundle contains unexpected asset "${assetId}".`);
        if (asset.contentType !== contentType) fail(`content type for "${assetId}" differs from the manifest.`);
        if (!SHA256_PATTERN.test(asset.sourceSha256)) fail(`source fingerprint for "${assetId}" is malformed.`);

        const payloadStart = asSafeNumber(assetPayloadOffset, 'record payload offset');
        const payloadEnd = asSafeNumber(assetPayloadOffset + storedSize, 'record payload end');
        const assetBytes = payload.slice(payloadStart, payloadEnd);
        const recordDigest = index.subarray(recordOffset + 40, recordOffset + 72);
        const payloadHash = await sha256(assetBytes, subtle);
        if (payloadHash !== hex(recordDigest)) fail(`payload digest for "${assetId}" does not match its RTAB record.`);
        if (payloadHash !== asset.sourceSha256) fail(`payload for "${assetId}" differs from its manifest source fingerprint.`);
        if (asset.contentType === 'PNG') {
            assertPlanetFingerprint(asset.logicalPath, asset.sourceSha256, payloadHash);
        }
        records.push({ assetId, bytes: assetBytes, contentType, asset });
        expectedStringCursor += idLength;
        expectedPayloadCursor += storedSize;
    }
    if (expectedStringCursor !== stringTableSizeBig) fail('string table contains unreferenced bytes.');
    if (expectedPayloadCursor !== BigInt(payload.byteLength)) fail('payload contains gaps or trailing bytes.');
    if (records.length !== expectedAssets.length || records.some((record, index) => record.assetId !== expectedAssets[index].assetId)) {
        fail(`bundle "${bundle.bundleId}" IDs differ from the manifest order.`);
    }
    return records;
}

export function resizeSvgForPhaser(svgText: string, scale = 0.5): string {
    const xml = new DOMParser().parseFromString(svgText, 'text/xml');
    const parserError = xml.getElementsByTagName('parsererror')[0];
    if (parserError) fail(`SVG XML is malformed: ${parserError.textContent ?? 'parser error'}`);
    const svg = xml.getElementsByTagName('svg')[0];
    if (!svg) fail('SVG payload has no root svg element.');

    let width: number | string | undefined;
    let height: number | string | undefined;
    let svgWidth: number | string = Number.parseFloat(svg.getAttribute('width') ?? '');
    let svgHeight: number | string = Number.parseFloat(svg.getAttribute('height') ?? '');
    if (scale) {
        const hasViewBox = svg.hasAttribute('viewBox');
        if (!hasViewBox && svgWidth && svgHeight) {
            svg.setAttribute('viewBox', `0  0 ${svgWidth} ${svgHeight}`);
        } else if (hasViewBox && !svgWidth && !svgHeight) {
            const viewBox = (svg.getAttribute('viewBox') ?? '').split(/\s+|,/);
            svgWidth = viewBox[2] ?? '';
            svgHeight = viewBox[3] ?? '';
        }
        if (svgWidth && svgHeight) {
            width = Number(svgWidth) * scale;
            height = Number(svgHeight) * scale;
        } else {
            return svgText;
        }
        svg.setAttribute('width', `${String(width)}px`);
        svg.setAttribute('height', `${String(height)}px`);
        return new XMLSerializer().serializeToString(svg);
    }
    return svgText;
}

async function decodeBrowserImage(bytes: Uint8Array, contentType: ContentType): Promise<HTMLImageElement> {
    const preparedBytes = contentType === 'SVG'
        ? new TextEncoder().encode(resizeSvgForPhaser(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 0.5))
        : bytes;
    const mimeType = contentType === 'SVG' ? 'image/svg+xml;charset=utf-8' : 'image/png';
    const exactBuffer = preparedBytes.buffer.slice(
        preparedBytes.byteOffset,
        preparedBytes.byteOffset + preparedBytes.byteLength
    ) as ArrayBuffer;
    const imageUrl = URL.createObjectURL(new Blob([exactBuffer], { type: mimeType }));
    const image = new Image();
    image.src = imageUrl;
    try {
        await image.decode();
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) fail(`decoded ${contentType} has empty dimensions.`);
        return image;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
}

export async function validatePlanetDimensions(image: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>, logicalPath: string): Promise<void> {
    if (image.naturalWidth !== PLANET_DIMENSIONS.width || image.naturalHeight !== PLANET_DIMENSIONS.height) {
        fail(`planet "${logicalPath}" decoded as ${image.naturalWidth}×${image.naturalHeight}; expected 2000×1000.`);
    }
}

export interface RuntimePreflightOptions {
    fetcher?: typeof fetch;
    subtle?: SubtleCrypto;
    decodeImage?: (bytes: Uint8Array, contentType: ContentType) => Promise<HTMLImageElement>;
    manifestUrl?: string;
}

export async function constructGameAfterRuntimePreflight<T>(
    preflight: () => Promise<PreparedRuntimeAssets>,
    construct: (prepared: PreparedRuntimeAssets) => T,
    onFailure: (error: unknown) => void
): Promise<T | undefined> {
    try {
        return construct(await preflight());
    } catch (error) {
        onFailure(error);
        return undefined;
    }
}

export async function preflightRtabAssets(options: RuntimePreflightOptions = {}): Promise<PreparedRuntimeAssets> {
    const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    const subtle = options.subtle ?? globalThis.crypto.subtle;
    const decodeImage = options.decodeImage ?? decodeBrowserImage;
    const manifestResponse = await fetcher(options.manifestUrl ?? '/assets/asset-manifest.json', { cache: 'no-store' });
    if (!manifestResponse.ok) fail(`manifest request failed with HTTP ${manifestResponse.status}.`);
    const manifest = await validateRuntimeManifest(await manifestResponse.json(), subtle);
    const assetsByBundle = new Map<string, RuntimeAssetMetadata[]>();
    for (const asset of manifest.assets) {
        assetsByBundle.set(asset.bundleId, [...(assetsByBundle.get(asset.bundleId) ?? []), asset]);
    }
    for (const assets of assetsByBundle.values()) {
        assets.sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
    }

    const bundles = await Promise.all(manifest.bundles.map(async (bundle) => {
        const response = await fetcher(bundle.bundleFile);
        if (!response.ok) fail(`bundle "${bundle.bundleId}" request failed with HTTP ${response.status}.`);
        const bytes = await response.arrayBuffer();
        return validateRtabBundle(bytes, bundle, assetsByBundle.get(bundle.bundleId) ?? [], subtle);
    }));

    const records = bundles.flat();
    const recordIds = new Set(records.map((record) => record.assetId));
    if (recordIds.size !== contractAssets.length || records.length !== contractAssets.length
        || manifest.assets.some((asset) => !recordIds.has(asset.assetId))) {
        fail('bundle coverage does not exactly match the generated runtime inventory.');
    }

    const prepared = await Promise.all(records.map(async (record) => {
        const image = await decodeImage(record.bytes, record.contentType);
        if (record.contentType === 'PNG') await validatePlanetDimensions(image, record.asset.logicalPath);
        return { asset: record.asset, image };
    }));
    return { manifest, assets: prepared };
}

export function expectedTextureNames(prepared: PreparedRuntimeAssets): string[] {
    const names = new Set<string>();
    for (const { asset } of prepared.assets) {
        for (const name of [asset.textureKey, ...asset.aliases]) {
            if (!name || names.has(name)) fail(`texture key or alias "${name}" is duplicated.`);
            names.add(name);
        }
    }
    if (prepared.assets.length !== contractAssets.length) fail('prepared texture count differs from the generated runtime contract.');
    return [...names];
}

export function registerPreparedTextures(
    textureManager: TextureManagerLike,
    prepared: PreparedRuntimeAssets
): void {
    const names = expectedTextureNames(prepared);
    for (const key of names) {
        if (textureManager.exists(key)) fail(`texture key "${key}" is already registered.`);
    }
    const createdKeys: string[] = [];
    try {
        for (const { asset, image } of prepared.assets) {
            const keys = [asset.textureKey, ...asset.aliases];
            for (const key of keys) {
                if (!textureManager.addImage(key, image)) fail(`Phaser refused texture key "${key}".`);
                createdKeys.push(key);
            }
        }
        for (const key of names) {
            if (!textureManager.exists(key)) fail(`texture key "${key}" is unavailable after registration.`);
        }
    } catch (error) {
        for (const key of createdKeys.reverse()) {
            if (textureManager.exists(key)) textureManager.remove(key);
        }
        throw error;
    }
}
