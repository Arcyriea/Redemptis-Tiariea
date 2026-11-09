import path from 'node:path';
import { prepareAssets } from './prepare-assets.mjs';
import { PROJECT_ROOT } from './asset-registry.mjs';

const CONTROL_FILES = new Set([
    'private/.asset-package-lock',
    'private/.asset-package-transaction.jsonl'
]);

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
        || normalizedPath === 'scripts/asset-registry.json';
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
        const operation = Promise.resolve().then(() => prepare({ projectRoot: resolvedProjectRoot }));
        activePreparation = operation;
        try {
            await operation;
            serverLogger?.info('Asset watcher reconciliation completed.');
        } catch (error) {
            serverLogger?.error(`Asset watcher reconciliation failed: ${error.message}`, { error });
            if (initial) {
                throw error;
            }
        } finally {
            if (activePreparation === operation) {
                activePreparation = null;
            }
            if (!closed) {
                if (recoveryPending) {
                    recoveryPending = false;
                    dirty = false;
                    void reconcile(false);
                } else if (dirty && !degraded) {
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
        serverLogger = null;
    }

    return {
        name: 'redemptis-asset-watcher',
        apply: 'serve',
        async configureServer(server) {
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
        closeServer: dispose
    };
}
