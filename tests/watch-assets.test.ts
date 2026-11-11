import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { createAssetWatcherPlugin, isRelevantAssetWatchPath } from '../scripts/watch-assets.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');

class FakeWatcher extends EventEmitter {}

function createFakeServer() {
    const watcher = new FakeWatcher();
    const messages: string[] = [];
    const reloads: object[] = [];
    return {
        watcher,
        messages,
        reloads,
        ws: { send: (message: object) => reloads.push(message) },
        middlewares: { use: () => {} },
        config: {
            logger: {
                info: (message: string) => messages.push(message),
                error: (message: string) => messages.push(message)
            }
        }
    };
}

function delay(milliseconds: number) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await delay(10);
    }
    assert.ok(predicate(), `condition was not met within ${timeoutMs}ms`);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test('asset watcher path filtering covers private lifecycle and registry on Windows', () => {
    const root = 'C:\\Game\\Project';
    assert.equal(isRelevantAssetWatchPath('C:\\Game\\Project\\private', root, 'win32'), true);
    assert.equal(isRelevantAssetWatchPath('private\\assets', root, 'win32'), true);
    assert.equal(
        isRelevantAssetWatchPath('PRIVATE\\ASSETS\\Ships\\human.svg', root, 'win32'),
        true
    );
    assert.equal(
        isRelevantAssetWatchPath('SCRIPTS\\ASSET-REGISTRY.JSON', root, 'win32'),
        true
    );
    assert.equal(isRelevantAssetWatchPath('scripts\\planet-asset-approvals.json', root, 'win32'), true);
    assert.equal(isRelevantAssetWatchPath('src\\assets\\planet-runtime-references.json', root, 'win32'), true);
    assert.equal(
        isRelevantAssetWatchPath('private\\.asset-package-lock', root, 'win32'),
        false
    );
    assert.equal(
        isRelevantAssetWatchPath('private\\.asset-package-transaction.jsonl', root, 'win32'),
        false
    );
    assert.equal(isRelevantAssetWatchPath('private\\other.txt', root, 'win32'), false);
    assert.equal(isRelevantAssetWatchPath('..\\outside.svg', root, 'win32'), false);
});

test('asset watcher debounces relevant events and ignores transaction-control files', async () => {
    let calls = 0;
    const plugin = createAssetWatcherPlugin({
        projectRoot: REPOSITORY_ROOT,
        debounceMs: 30,
        prepare: async () => {
            calls += 1;
        }
    });
    const server = createFakeServer();

    await plugin.configureServer(server);
    assert.equal(calls, 1);
    server.watcher.emit('all', 'add', path.join(REPOSITORY_ROOT, 'private', 'assets', 'Ships', 'new.svg'));
    server.watcher.emit('all', 'unlink', path.join(REPOSITORY_ROOT, 'private', 'assets', 'Ships', 'old.svg'));
    server.watcher.emit('all', 'add', path.join(REPOSITORY_ROOT, 'private', '.asset-package-lock'));
    server.watcher.emit('all', 'change', path.join(REPOSITORY_ROOT, 'public', 'assets', 'ships.bin'));
    await delay(90);

    assert.equal(calls, 2);
    assert.equal(server.reloads.length, 1);
    await plugin.closeServer();
});

test('asset watcher serializes preparations and coalesces events during an active pass', async () => {
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const secondPass = deferred();
    const secondPassStarted = deferred();
    const plugin = createAssetWatcherPlugin({
        projectRoot: REPOSITORY_ROOT,
        debounceMs: 25,
        prepare: async () => {
            calls += 1;
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            try {
                if (calls === 2) {
                    secondPassStarted.resolve();
                    await secondPass.promise;
                }
            } finally {
                active -= 1;
            }
        }
    });
    const server = createFakeServer();

    await plugin.configureServer(server);
    server.watcher.emit('all', 'change', path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'));
    await secondPassStarted.promise;
    server.watcher.emit('all', 'add', path.join(REPOSITORY_ROOT, 'private', 'assets', 'Ships', 'a.svg'));
    server.watcher.emit('all', 'unlink', path.join(REPOSITORY_ROOT, 'private', 'assets', 'Ships', 'b.svg'));
    await delay(70);
    assert.equal(calls, 2);
    assert.equal(server.reloads.length, 0);

    secondPass.resolve();
    await waitFor(() => calls === 3);
    await delay(60);
    assert.equal(calls, 3);
    assert.equal(server.reloads.length, 1);
    assert.equal(maximumActive, 1);
    await plugin.closeServer();
});

test('asset watcher does not lose changes observed during startup reconciliation', async () => {
    const startup = deferred();
    const startupStarted = deferred();
    let calls = 0;
    const plugin = createAssetWatcherPlugin({
        projectRoot: REPOSITORY_ROOT,
        debounceMs: 20,
        prepare: async () => {
            calls += 1;
            if (calls === 1) {
                startupStarted.resolve();
                await startup.promise;
            }
        }
    });
    const server = createFakeServer();

    const configuring = plugin.configureServer(server);
    await startupStarted.promise;
    server.watcher.emit('all', 'addDir', path.join(REPOSITORY_ROOT, 'private', 'assets', 'NewCategory'));
    startup.resolve();
    await configuring;
    await waitFor(() => calls === 2);
    await plugin.closeServer();
});

test('asset watcher logs failed reconciliations without retrying unchanged invalid sources', async () => {
    let calls = 0;
    const plugin = createAssetWatcherPlugin({
        projectRoot: REPOSITORY_ROOT,
        debounceMs: 20,
        prepare: async () => {
            calls += 1;
            if (calls > 1) {
                throw new Error('invalid registered source');
            }
        }
    });
    const server = createFakeServer();

    await plugin.configureServer(server);
    server.watcher.emit('all', 'change', path.join(REPOSITORY_ROOT, 'private', 'assets', 'Ships', 'bad.svg'));
    await waitFor(() => calls === 2);
    await delay(70);
    assert.equal(calls, 2);
    assert.ok(server.messages.some((message) => message.includes('invalid registered source')));
    assert.equal(server.reloads.length, 0);

    server.watcher.emit('error', new Error('watch backend failed'));
    await waitFor(() => calls === 3);
    server.watcher.emit('all', 'change', path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'));
    await delay(70);
    assert.equal(calls, 3);
    assert.ok(server.messages.some((message) => message.includes('monitoring is degraded')));
    await plugin.closeServer();
});

test('asset watcher suppresses HMR for editable contract inputs and generated runtime outputs', async () => {
    const plugin = createAssetWatcherPlugin({ projectRoot: REPOSITORY_ROOT, prepare: async () => {} });
    const stale = plugin.handleHotUpdate({ file: path.join(REPOSITORY_ROOT, 'scripts', 'planet-asset-approvals.json') });
    const generated = plugin.handleHotUpdate({ file: path.join(REPOSITORY_ROOT, 'src', 'generated', 'runtimeAssetContract.ts') });
    assert.deepEqual(stale, []);
    assert.deepEqual(generated, []);
});

test('asset watcher disposal cancels pending reconciliation', async () => {
    let calls = 0;
    const plugin = createAssetWatcherPlugin({
        projectRoot: REPOSITORY_ROOT,
        debounceMs: 50,
        prepare: async () => {
            calls += 1;
        }
    });
    const server = createFakeServer();

    await plugin.configureServer(server);
    server.watcher.emit('all', 'change', path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'));
    await plugin.closeServer();
    await delay(90);
    assert.equal(calls, 1);
    assert.equal(server.watcher.listenerCount('all'), 0);
    assert.equal(server.watcher.listenerCount('error'), 0);
});

test('installed Vite watcher detects changes and directory lifecycle inside ignored private/assets on Windows', {
    skip: process.platform !== 'win32'
}, async () => {
    const privateRoot = path.join(REPOSITORY_ROOT, 'private');
    let createdPrivate = false;
    try {
        await lstat(privateRoot);
    } catch (error: any) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        createdPrivate = true;
    }

    let watchRoot: string | undefined;
    let viteServer: ViteDevServer | undefined;
    let reconcileCount = 0;
    const observedEvents: string[] = [];
    const waitForReconciliations = async (target: number) => {
        try {
            await waitFor(() => reconcileCount >= target, 5000);
        } catch (error) {
            throw new Error(
                `${(error as Error).message}; Vite events: ${observedEvents.join(', ')}; `
                + `watched: ${JSON.stringify(viteServer?.watcher.getWatched())}`
            );
        }
    };

    try {
        await mkdir(privateRoot, { recursive: true });
        watchRoot = await mkdtemp(path.join(privateRoot, 'WatcherIntegration-'));
        const ignoredPath = path.relative(REPOSITORY_ROOT, watchRoot);
        execFileSync('git', ['check-ignore', '--quiet', '--', ignoredPath], { cwd: REPOSITORY_ROOT });

        const ready = deferred();
        const readyPlugin: Plugin = {
            name: 'asset-watcher-integration-ready',
            enforce: 'pre',
            configureServer(server) {
                server.watcher.once('ready', ready.resolve);
            }
        };
        const assetPlugin = createAssetWatcherPlugin({
            projectRoot: watchRoot,
            debounceMs: 75,
            prepare: async () => {
                reconcileCount += 1;
            },
        });

        try {
            viteServer = await createServer({
                root: watchRoot,
                configFile: false,
                publicDir: false,
                server: {
                    host: '127.0.0.1',
                    port: 0,
                    strictPort: true,
                    watch: { ignorePermissionErrors: false }
                },
                plugins: [readyPlugin, assetPlugin]
            });
            viteServer.watcher.on('all', (eventName, eventPath) => observedEvents.push(`${eventName}:${eventPath}`));
            await viteServer.listen();
            await ready.promise;
            assert.equal(reconcileCount, 1);

            const isolatedPrivate = path.join(watchRoot, 'private');
            const assetsRoot = path.join(isolatedPrivate, 'assets');
            const category = path.join(assetsRoot, 'Temporary Category');
            await mkdir(isolatedPrivate);
            await waitForReconciliations(2);
            await writeFile(path.join(isolatedPrivate, '.asset-package-lock'), '{}');
            await writeFile(path.join(isolatedPrivate, '.asset-package-transaction.jsonl'), '{}');
            await delay(200);
            assert.equal(reconcileCount, 2);

            await mkdir(assetsRoot);
            await waitForReconciliations(3);
            await mkdir(category);
            await waitForReconciliations(4);
            const nested = path.join(category, 'nested');
            const svgPath = path.join(nested, 'test.svg');
            await mkdir(nested);
            await writeFile(svgPath, '<svg/>');
            await waitForReconciliations(5);
            await writeFile(svgPath, '<svg><path/></svg>');
            await waitForReconciliations(6);
            await rm(category, { recursive: true });
            await waitForReconciliations(7);
            await rm(assetsRoot, { recursive: true });
            await waitForReconciliations(8);
            await rm(isolatedPrivate, { recursive: true });
            await waitForReconciliations(9);
        } finally {
            if (viteServer) {
                await viteServer.close();
            }
        }
    } finally {
        if (watchRoot) {
            await rm(watchRoot, { recursive: true, force: true });
        }
        if (createdPrivate) {
            await rmdir(privateRoot).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') {
                    throw error;
                }
            });
        }
    }
});
