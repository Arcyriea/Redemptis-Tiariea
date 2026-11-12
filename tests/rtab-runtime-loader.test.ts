import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import {
    assertPlanetFingerprint,
    constructGameAfterRuntimePreflight,
    expectedTextureNames,
    preflightRtabAssets,
    registerPreparedTextures,
    type PreparedRuntimeAssets,
    type TextureManagerLike
} from '../src/assets/rtabRuntimeLoader';

const ROOT = path.resolve(import.meta.dirname, '..');

async function readJson(filePath: string) {
    return JSON.parse(await readFile(path.join(ROOT, filePath), 'utf8'));
}

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function runtimeFetch(manifestOverride?: unknown, bundleOverride?: Map<string, Uint8Array>): Promise<typeof fetch> {
    const manifest = manifestOverride ?? await readJson('public/assets/asset-manifest.json');
    const bundleFiles = new Map<string, Uint8Array>();
    const manifestBundles = (manifest as { bundles: Array<{ bundleFile: string }> }).bundles;
    for (const entry of manifestBundles) {
        const override = bundleOverride?.get(entry.bundleFile);
        const bytes = override ?? new Uint8Array(await readFile(path.join(ROOT, 'public', entry.bundleFile.slice(1))));
        bundleFiles.set(entry.bundleFile, bytes);
    }
    return (async (input: RequestInfo | URL) => {
        const requestUrl = String(input);
        if (requestUrl === '/assets/asset-manifest.json') return response(manifest);
        const bytes = bundleFiles.get(requestUrl);
        if (!bytes) return new Response('missing', { status: 404 });
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }) as typeof fetch;
}

function fakeImage(contentType: string, width = 32, height = 24): HTMLImageElement {
    return { naturalWidth: contentType === 'PNG' ? width : width, naturalHeight: height } as HTMLImageElement;
}

test('preflights all four bundles and decodes the complete generated runtime inventory', async () => {
    const fetcher = await runtimeFetch();
    const manifest = await readJson('public/assets/asset-manifest.json');
    let decodeCalls = 0;
    const prepared = await preflightRtabAssets({
        fetcher,
        subtle: webcrypto.subtle,
        decodeImage: async (_bytes, contentType) => {
            decodeCalls += 1;
            return contentType === 'PNG' ? fakeImage(contentType, 2000, 1000) : fakeImage(contentType);
        }
    });
    assert.equal(prepared.assets.length, manifest.assets.length);
    assert.equal(decodeCalls, manifest.assets.length);
    assert.equal(expectedTextureNames(prepared).length,
        manifest.assets.length + manifest.assets.reduce((count: number, asset: any) => count + asset.aliases.length, 0));
});

test('rejects an altered planet payload independently of manifest metadata', () => {
    assert.throws(
        () => assertPlanetFingerprint('assets/Planets/Map-111.png', '83d39b7a7603f574f47cee57c4d9b12b0b468b469fece0ffe7765d921f067ea1', '0'.repeat(64)),
        /payload fingerprint.*not approved/
    );
});

test('preflight generation mismatch prevents the injected game factory from constructing Phaser', async () => {
    const manifest = await readJson('public/assets/asset-manifest.json');
    (manifest as any).generationId = '0'.repeat(64);
    let bundleRequests = 0;
    let gameConstructions = 0;
    let displayedError = '';
    const fetcher: typeof fetch = async (input) => {
        if (String(input) === '/assets/asset-manifest.json') return response(manifest);
        bundleRequests += 1;
        return new Response('unexpected bundle request', { status: 500 });
    };
    const result = await constructGameAfterRuntimePreflight(
        () => preflightRtabAssets({ fetcher, subtle: webcrypto.subtle }),
        () => { gameConstructions += 1; return {}; },
        (error) => { displayedError = error instanceof Error ? error.message : String(error); }
    );
    assert.equal(result, undefined);
    assert.equal(bundleRequests, 0);
    assert.equal(gameConstructions, 0);
    assert.match(displayedError, /generation ID/);
});

test('rejects a changed planet manifest fingerprint even before reading bundles', async () => {
    const manifest = await readJson('public/assets/asset-manifest.json');
    const asset = (manifest as any).assets.find((entry: any) => entry.logicalPath === 'assets/Planets/Map-122.png');
    asset.sourceSha256 = '0'.repeat(64);
    let requestedBundles = 0;
    const baseFetch = await runtimeFetch(manifest);
    const fetcher: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url !== '/assets/asset-manifest.json') requestedBundles += 1;
        return baseFetch(input, init);
    };
    await assert.rejects(preflightRtabAssets({ fetcher, subtle: webcrypto.subtle }), /identity differs/);
    assert.equal(requestedBundles, 0);
});

test('rejects incorrect decoded planet dimensions', async () => {
    const fetcher = await runtimeFetch();
    await assert.rejects(preflightRtabAssets({
        fetcher,
        subtle: webcrypto.subtle,
        decodeImage: async (_bytes, contentType) => fakeImage(contentType, 1999, 1000)
    }), /expected 2000×1000/);
});

test('does not return prepared assets when any image decode fails', async () => {
    const fetcher = await runtimeFetch();
    let calls = 0;
    await assert.rejects(preflightRtabAssets({
        fetcher,
        subtle: webcrypto.subtle,
        decodeImage: async () => {
            calls += 1;
            if (calls === 10) throw new Error('synthetic decode failure');
            return fakeImage('SVG');
        }
    }), /synthetic decode failure/);
});

test('rejects a missing required bundle before invoking any image decoder', async () => {
    const manifest = await readJson('public/assets/asset-manifest.json');
    const baseFetch = await runtimeFetch(manifest);
    let decodeCalls = 0;
    const shipsBundle = (manifest as any).bundles.find((bundle: any) => bundle.bundleId === 'ships').bundleFile;
    const fetcher: typeof fetch = async (input, init) => (
        String(input) === shipsBundle ? new Response('missing', { status: 404 }) : baseFetch(input, init)
    );
    await assert.rejects(preflightRtabAssets({
        fetcher,
        subtle: webcrypto.subtle,
        decodeImage: async () => {
            decodeCalls += 1;
            return fakeImage('SVG');
        }
    }), /bundle "ships" request failed with HTTP 404/);
    assert.equal(decodeCalls, 0);
});

test('rejects corrupted bundle payloads before decoding', async () => {
    const manifest = await readJson('public/assets/asset-manifest.json');
    const targetBundle = (manifest as any).bundles.find((bundle: any) => bundle.bundleId === 'components').bundleFile;
    const original = new Uint8Array(await readFile(path.join(ROOT, 'public', targetBundle.slice(1))));
    const corrupted = new Uint8Array(original);
    const payloadOffset = Number(new DataView(corrupted.buffer).getBigUint64(8, true));
    corrupted[payloadOffset] ^= 0xff;
    const fetcher = await runtimeFetch(manifest, new Map([[targetBundle, corrupted]]));
    let decodeCalls = 0;
    await assert.rejects(preflightRtabAssets({
        fetcher,
        subtle: webcrypto.subtle,
        decodeImage: async () => {
            decodeCalls += 1;
            return fakeImage('SVG');
        }
    }), /bundle "components" SHA-256 mismatch/);
    assert.equal(decodeCalls, 0);
});

class FakeTextureManager implements TextureManagerLike {
    readonly textures = new Map<string, HTMLImageElement>();
    readonly removed: string[] = [];
    failAtCall = -1;
    private addCalls = 0;

    exists(key: string): boolean {
        return this.textures.has(key);
    }

    addImage(key: string, image: HTMLImageElement): unknown | null {
        this.addCalls += 1;
        if (this.addCalls === this.failAtCall) throw new Error('synthetic Texture Manager failure');
        if (this.textures.has(key)) return null;
        this.textures.set(key, image);
        return { key };
    }

    remove(key: string): unknown {
        this.removed.push(key);
        return this.textures.delete(key);
    }
}

async function createPrepared(): Promise<PreparedRuntimeAssets> {
    return preflightRtabAssets({
        fetcher: await runtimeFetch(),
        subtle: webcrypto.subtle,
        decodeImage: async (_bytes, type) => fakeImage(type, 2000, 1000)
    });
}

test('registers every primary texture and alias and reuses each image for its aliases', async () => {
    const prepared = await createPrepared();
    const manager = new FakeTextureManager();
    registerPreparedTextures(manager, prepared);
    assert.equal(manager.textures.size, expectedTextureNames(prepared).length);
    const aliased = prepared.assets.find(({ asset }) => asset.aliases.includes('human-dreadnought'))!;
    assert.equal(manager.textures.get(aliased.asset.textureKey), aliased.image);
    assert.equal(manager.textures.get('human-dreadnought'), aliased.image);
    assert.equal(manager.textures.get('central-hull'), prepared.assets.find(({ asset }) => asset.aliases.includes('central-hull'))!.image);
});

test('preflights key collisions without modifying existing textures', async () => {
    const prepared = await createPrepared();
    const manager = new FakeTextureManager();
    manager.textures.set('alien-interceptor', fakeImage('SVG'));
    await assert.rejects(Promise.resolve().then(() => registerPreparedTextures(manager, prepared)), /already registered/);
    assert.equal(manager.textures.size, 1);
    assert.equal(manager.removed.length, 0);
});

test('rolls back only textures registered by the current attempt after failure', async () => {
    const prepared = await createPrepared();
    const manager = new FakeTextureManager();
    const existing = fakeImage('SVG');
    manager.textures.set('preexisting-user-texture', existing);
    manager.failAtCall = 5;
    assert.throws(() => registerPreparedTextures(manager, prepared), /synthetic Texture Manager failure/);
    assert.deepEqual([...manager.textures.keys()], ['preexisting-user-texture']);
    assert.equal(manager.textures.get('preexisting-user-texture'), existing);
    assert.equal(manager.removed.length, 4);
});

test('preserves the three approved planet aliases and texture names in the prepared inventory', async () => {
    const prepared = await createPrepared();
    const names = new Set(expectedTextureNames(prepared));
    for (const key of [
        'planetMap111', 'planetMap122', 'planetMap692',
        'planetMapHushanyia', 'planetMapKansansas',
        'central-hull', 'human-dreadnought', 'alien-interceptor'
    ]) {
        assert.equal(names.has(key), true, `Missing texture key ${key}`);
    }
});
