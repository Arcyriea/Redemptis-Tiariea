import path from 'node:path';
import { prepareAssets } from './prepare-assets.mjs';
import { PROJECT_ROOT } from './asset-registry.mjs';

const CONTROL_FILES = new Set([
    'private/.asset-package-lock',
    'private/.asset-package-transaction.jsonl'
]);
const CONTRACT_INPUTS = new Set([
    'scripts/asset-registry.json',
    'scripts/planet-asset-approvals.json',
    'src/assets/planet-runtime-references.json'
]);
const GENERATED_RUNTIME_OUTPUTS = new Set([
    'src/generated/runtimeassetcontract.ts',
    'src/generated/publicsvgmanifest.ts'
]);

function applyAssetCacheHeaders(server) {
    server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? '').split('?', 1)[0];
        if (pathname === '/assets/asset-manifest.json') {
            response.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
        } else if (/^\/assets\/[a-z0-9]+(?:-[a-z0-9]+)*\.[a-f0-9]{64}\.bin$/.test(pathname)) {
            response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        next();
    });
}

export function isRelevantAssetWatchPath(filePath, projectRoot = PROJECT_ROOT, platform = process.platform) {
    const pathApi = platform === 'win32' ? path.win32 : path;
    const root = pathApi.resolve(projectRoot);
    const absolutePath = pathApi.isAbsolute(filePath)
        ? pathApi.resolve(filePath)
        : pathApi.resolve(root, filePath);
    const relativePath = pathApi.relative(root, absolutePath)
        .split(pathApi.sep)
        .join('/')
        .replace(/\/+$/, '');
    const normalizedPath = platform === 'win32' ? relativePath.toLowerCase() : relativePath;

    if (!normalizedPath || normalizedPath === '..' || normalizedPath.startsWith('../')) {
        return false;
    }
    if (CONTROL_FILES.has(normalizedPath)) {
        return false;
    }

    return normalizedPath === 'private'
        || normalizedPath === 'private/assets'
        || normalizedPath.startsWith('private/assets/')
        || CONTRACT_INPUTS.has(normalizedPath);
}

export function createAssetWatcherPlugin({
    projectRoot = PROJECT_ROOT,
    debounceMs = 200,
    prepare = prepareAssets
} = {}) {
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
        throw new RangeError('Asset watcher debounceMs must be a non-negative finite number');
    }
    if (typeof prepare !== 'function') {
        throw new TypeError('Asset watcher prepare must be a function');
    }

    const resolvedProjectRoot = path.resolve(projectRoot);
    let activePreparation = null;
    let debounceTimer = null;
    let dirty = false;
    let closed = false;
    let degraded = false;
    let recoveryPending = false;
    let watcherErrorHandled = false;
    let serverWatcher = null;
    let serverLogger = null;
    let viteServer = null;
    let onAll = null;
    let onError = null;

    function clearTimer() {
        if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }

    function scheduleReconciliation() {
        if (closed || degraded) {
            return;
        }
        clearTimer();
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (closed || degraded || !dirty || activePreparation) {
                return;
            }
            dirty = false;
            void reconcile(false);
        }, debounceMs);
    }

    async function reconcile(initial) {
        if (closed) {
            return;
        }
        const operation = (async () => {
            let finalPassSucceeded = false;
            do {
                dirty = false;
                try {
                    await prepare({ projectRoot: resolvedProjectRoot });
                    finalPassSucceeded = true;
                    serverLogger?.info('Asset watcher reconciliation completed.');
                } catch (error) {
                    finalPassSucceeded = false;
                    serverLogger?.error(`Asset watcher reconciliation failed: ${error.message}`, { error });
                    if (initial) throw error;
                    if (!dirty) break;
                }
                if (recoveryPending) {
                    recoveryPending = false;
                    dirty = true;
                }
            } while (dirty && !closed);
            if (finalPassSucceeded && !initial && !dirty && !closed) {
                viteServer?.ws?.send({ type: 'full-reload' });
            }
        })();
        activePreparation = operation;
        try {
            await operation;
        } finally {
            if (activePreparation === operation) {
                activePreparation = null;
            }
            if (!closed) {
                if (dirty && !degraded) {
                    scheduleReconciliation();
                }
            }
        }
    }

    function onRelevantEvent(_eventName, eventPath) {
        if (closed || degraded || !isRelevantAssetWatchPath(eventPath, resolvedProjectRoot)) {
            return;
        }
        dirty = true;
        scheduleReconciliation();
    }

    function onWatcherError(error) {
        if (closed || watcherErrorHandled) {
            return;
        }
        watcherErrorHandled = true;
        degraded = true;
        clearTimer();
        dirty = false;
        serverLogger?.error(
            `Asset watcher failed and monitoring is degraded; restart the dev server after recovery: ${error.message}`,
            { error }
        );
        if (activePreparation) {
            recoveryPending = true;
        } else {
            void reconcile(false);
        }
    }

    async function dispose() {
        if (closed) {
            return;
        }
        closed = true;
        dirty = false;
        recoveryPending = false;
        clearTimer();
        serverWatcher?.off('all', onAll);
        serverWatcher?.off('error', onError);
        if (activePreparation) {
            await activePreparation.catch(() => {});
        }
        serverWatcher = null;
        viteServer = null;
        serverLogger = null;
    }

    return {
        name: 'redemptis-asset-watcher',
        apply: 'serve',
        async configureServer(server) {
            viteServer = server;
            applyAssetCacheHeaders(server);
            serverWatcher = server.watcher;
            serverLogger = server.config.logger;
            onAll = onRelevantEvent;
            onError = onWatcherError;
            serverWatcher.on('all', onAll);
            serverWatcher.on('error', onError);
            dirty = false;

            try {
                await reconcile(true);
            } catch (error) {
                await dispose();
                throw error;
            }

            if (dirty && !degraded) {
                scheduleReconciliation();
            }
        },
        handleHotUpdate(context) {
            const relative = path.relative(resolvedProjectRoot, context.file)
                .split(path.sep).join('/');
            const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
            if (isRelevantAssetWatchPath(context.file, resolvedProjectRoot)
                || GENERATED_RUNTIME_OUTPUTS.has(normalized)) {
                return [];
            }
        },
        configurePreviewServer(server) {
            applyAssetCacheHeaders(server);
        },
        closeServer: dispose
    };
}
