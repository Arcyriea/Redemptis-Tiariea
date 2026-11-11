import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
    validateRtabBundle,
    validateRuntimeManifest,
    type RuntimeBundleMetadata
} from '../src/assets/rtabRuntimeLoader';
import { runtimeAssetContract } from '../src/generated/runtimeAssetContract';
import { canonicalizeGenerationInput, computeGenerationId } from '../src/assets/rtabContractShared.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

async function readManifest() {
    return JSON.parse(await readFile(path.join(ROOT, 'public/assets/asset-manifest.json'), 'utf8'));
}

function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

function resealIndexAndBundle(bytes: Buffer, sourceBundle: RuntimeBundleMetadata): RuntimeBundleMetadata {
    const indexSize = Number(bytes.readBigUInt64LE(24));
    const digestOffset = 64 + indexSize - 32;
    createHash('sha256').update(bytes.subarray(64, digestOffset)).digest().copy(bytes, digestOffset);
    return { ...sourceBundle, bundleSha256: sha256(bytes) };
}

test('validates schema 1.3 and the generated current 34-asset inventory', async () => {
    const manifest = await validateRuntimeManifest(await readManifest(), webcrypto.subtle);
    assert.equal(manifest.assets.length, 34);
    assert.equal(manifest.assets.filter((asset) => asset.contentType === 'SVG').length, 31);
    assert.equal(manifest.assets.filter((asset) => asset.contentType === 'PNG').length, 3);
    assert.deepEqual(manifest.bundles.map((bundle) => [bundle.bundleId, bundle.formatVersion, bundle.assetCount]), [
        ['components', '1.0', 19],
        ['planets', '1.1', 3],
        ['ships', '1.0', 10],
        ['turrets-platforms', '1.0', 2]
    ]);
});

test('Node and Web Crypto derive the same generation ID without bundle metadata in the runtime contract', async () => {
    const manifest = await readManifest();
    const input = canonicalizeGenerationInput({
        assets: manifest.assets,
        bundles: manifest.bundles,
        approvals: runtimeAssetContract.approvedPlanetSourceSha256,
        placements: manifest.activePlanetPlacements
    });
    const nodeId = computeGenerationId(input, (serialized: string) => (
        createHash('sha256').update(serialized, 'utf8').digest('hex')
    ));
    const browserId = await computeGenerationId(input, async (serialized: string) => {
        const bytes = new TextEncoder().encode(serialized);
        return Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)), (byte) => (
            byte.toString(16).padStart(2, '0')
        )).join('');
    });
    assert.equal(typeof nodeId, 'string');
    assert.equal(nodeId, browserId);
    assert.equal(nodeId, manifest.generationId);
    assert.equal(nodeId, runtimeAssetContract.generationId);
    assert.equal('bundles' in runtimeAssetContract, false);
});

test('rejects an unsupported manifest version, duplicate identity, and unexpected identity', async () => {
    const source = await readManifest();
    await assert.rejects(validateRuntimeManifest({ ...source, manifestSchemaVersion: '1.1' }, webcrypto.subtle), /manifestSchemaVersion/);

    const duplicate = structuredClone(source);
    duplicate.assets[1].assetId = duplicate.assets[0].assetId;
    await assert.rejects(validateRuntimeManifest(duplicate, webcrypto.subtle), /identity differs|repeats asset ID/);

    const unexpected = structuredClone(source);
    unexpected.assets[0].assetId = 'rt.unexpected';
    await assert.rejects(validateRuntimeManifest(unexpected, webcrypto.subtle), /identity differs/);

    const wrongFilenameDigest = structuredClone(source);
    wrongFilenameDigest.bundles[0].bundleFile = wrongFilenameDigest.bundles[0].bundleFile.replace(
        /\.([a-f0-9]{64})\.bin$/,
        `.${'0'.repeat(64)}.bin`
    );
    await assert.rejects(validateRuntimeManifest(wrongFilenameDigest, webcrypto.subtle), /content-addressed URL/);
});

test('parses RTAB 1.0 SVG and RTAB 1.1 PNG bundles and verifies each record', async () => {
    const manifest = await validateRuntimeManifest(await readManifest(), webcrypto.subtle);
    for (const bundle of manifest.bundles) {
        const bundleBytes = await readFile(path.join(ROOT, 'public', bundle.bundleFile.slice(1)));
        const assets = manifest.assets
            .filter((asset) => asset.bundleId === bundle.bundleId)
            .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
        const records = await validateRtabBundle(bundleBytes, bundle, assets, webcrypto.subtle);
        assert.equal(records.length, bundle.assetCount);
        assert.ok(records.every((record) => record.asset.contentType === (bundle.bundleId === 'planets' ? 'PNG' : 'SVG')));
    }
});

test('rejects altered complete-bundle fingerprints', async () => {
    const manifest = await validateRuntimeManifest(await readManifest(), webcrypto.subtle);
    const bundle = manifest.bundles[0];
    const assets = manifest.assets.filter((asset) => asset.bundleId === bundle.bundleId)
        .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
    const bytes = await readFile(path.join(ROOT, 'public', bundle.bundleFile.slice(1)));
    const altered = Buffer.from(bytes);
    altered[4] ^= 0x01;
    await assert.rejects(validateRtabBundle(altered, bundle, assets, webcrypto.subtle), /bundle .* SHA-256 mismatch/);
});

test('rejects unsupported header flags after the complete bundle hash is updated', async () => {
    const manifest = await validateRuntimeManifest(await readManifest(), webcrypto.subtle);
    const sourceBundle = manifest.bundles[0];
    const assets = manifest.assets.filter((asset) => asset.bundleId === sourceBundle.bundleId)
        .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
    const bytes = Buffer.from(await readFile(path.join(ROOT, 'public', sourceBundle.bundleFile.slice(1))));
    bytes.writeUInt16LE(0, 6);
    const bundle = { ...sourceBundle, bundleSha256: sha256(bytes) };
    await assert.rejects(validateRtabBundle(bytes, bundle, assets, webcrypto.subtle), /header flags/);
});

test('rejects an invalid index digest and truncated bundle data', async () => {
    const manifest = await validateRuntimeManifest(await readManifest(), webcrypto.subtle);
    const sourceBundle = manifest.bundles[0];
    const assets = manifest.assets.filter((asset) => asset.bundleId === sourceBundle.bundleId)
        .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
    const source = Buffer.from(await readFile(path.join(ROOT, 'public', sourceBundle.bundleFile.slice(1))));
    const indexSize = Number(source.readBigUInt64LE(24));
    const payloadOffset = Number(source.readBigUInt64LE(8));
    const brokenIndex = Buffer.from(source);
    brokenIndex[HEADER_DIGEST_OFFSET(payloadOffset, indexSize)] ^= 0xff;
    const indexBundle = { ...sourceBundle, bundleSha256: sha256(brokenIndex) };
    await assert.rejects(validateRtabBundle(brokenIndex, indexBundle, assets, webcrypto.subtle), /index SHA-256 mismatch/);

    const truncated = source.subarray(0, 40);
    const truncatedBundle: RuntimeBundleMetadata = { ...sourceBundle, bundleSha256: sha256(truncated) };
    await assert.rejects(validateRtabBundle(truncated, truncatedBundle, assets, webcrypto.subtle), /shorter than its header/);
});

test('rejects RTAB 1.0 PNG records and nonzero record flags', async () => {
    const manifest = await validateRuntimeManifest(await readManifest(), webcrypto.subtle);
    const sourceBundle = manifest.bundles.find((candidate) => candidate.bundleId === 'ships')!;
    const assets = manifest.assets.filter((asset) => asset.bundleId === sourceBundle.bundleId)
        .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
    const bundlePath = path.join(ROOT, 'public', sourceBundle.bundleFile.slice(1));

    const pngType = Buffer.from(await readFile(bundlePath));
    pngType.writeUInt16LE(1, 64 + 28 + 32);
    await assert.rejects(
        validateRtabBundle(pngType, resealIndexAndBundle(pngType, sourceBundle), assets, webcrypto.subtle),
        /content type is not supported by the RTAB version/
    );

    const flagged = Buffer.from(await readFile(bundlePath));
    flagged.writeUInt32LE(1, 64 + 28 + 36);
    await assert.rejects(
        validateRtabBundle(flagged, resealIndexAndBundle(flagged, sourceBundle), assets, webcrypto.subtle),
        /record flags must be zero/
    );
});

test('rejects payload corruption, unsafe offsets, and source-fingerprint mismatches', async () => {
    const manifest = await validateRuntimeManifest(await readManifest(), webcrypto.subtle);
    const sourceBundle = manifest.bundles.find((candidate) => candidate.bundleId === 'ships')!;
    const assets = manifest.assets.filter((asset) => asset.bundleId === sourceBundle.bundleId)
        .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
    const bundlePath = path.join(ROOT, 'public', sourceBundle.bundleFile.slice(1));

    const corruptPayload = Buffer.from(await readFile(bundlePath));
    const payloadOffset = Number(corruptPayload.readBigUInt64LE(8));
    corruptPayload[payloadOffset] ^= 0xff;
    const corruptMetadata = { ...sourceBundle, bundleSha256: sha256(corruptPayload) };
    await assert.rejects(validateRtabBundle(corruptPayload, corruptMetadata, assets, webcrypto.subtle), /payload digest/);

    const unsafeOffset = Buffer.from(await readFile(bundlePath));
    unsafeOffset.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 8);
    const unsafeMetadata = { ...sourceBundle, bundleSha256: sha256(unsafeOffset) };
    await assert.rejects(validateRtabBundle(unsafeOffset, unsafeMetadata, assets, webcrypto.subtle), /payload must immediately follow|outside the bundle/);

    const wrongSource = assets.map((asset, index) => index === 0 ? { ...asset, sourceSha256: '0'.repeat(64) } : asset);
    const original = await readFile(bundlePath);
    await assert.rejects(validateRtabBundle(original, sourceBundle, wrongSource, webcrypto.subtle), /differs from its manifest source fingerprint/);
});

test('rejects manifest and binary format-version mismatches', async () => {
    const manifest = await validateRuntimeManifest(await readManifest(), webcrypto.subtle);
    const sourceBundle = manifest.bundles.find((candidate) => candidate.bundleId === 'ships')!;
    const assets = manifest.assets.filter((asset) => asset.bundleId === sourceBundle.bundleId)
        .sort((left, right) => left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0);
    const bytes = Buffer.from(await readFile(path.join(ROOT, 'public', sourceBundle.bundleFile.slice(1))));
    bytes.writeUInt16LE(0x0101, 4);
    await assert.rejects(
        validateRtabBundle(bytes, { ...sourceBundle, bundleSha256: sha256(bytes) }, assets, webcrypto.subtle),
        /version differs from the manifest/
    );
    await assert.rejects(validateRtabBundle(bytes, sourceBundle, assets, webcrypto.subtle), /bundle .* SHA-256 mismatch/);
});

function HEADER_DIGEST_OFFSET(payloadOffset: number, indexSize: number): number {
    return payloadOffset - indexSize + indexSize - 1;
}
