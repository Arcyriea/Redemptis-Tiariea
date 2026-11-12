import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectPrivateAssetsRoot, resolveAssetSource } from '../scripts/asset-registry.mjs';

async function withTemporaryDirectories(run: (projectRoot: string, externalRoot: string) => Promise<void>) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'private-root-'));
    const projectRoot = path.join(tempRoot, 'project');
    const externalRoot = path.join(tempRoot, 'external-private');
    await mkdir(projectRoot, { recursive: true });
    try {
        await run(projectRoot, externalRoot);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

test('private source root accepts an ordinary directory', async () => {
    await withTemporaryDirectories(async (projectRoot) => {
        await mkdir(path.join(projectRoot, 'private', 'assets', 'Planets'), { recursive: true });
        const roots = await inspectPrivateAssetsRoot(projectRoot);
        assert.ok(roots);
        assert.equal(roots.privateRootIsSymlink, false);
        assert.equal(path.basename(roots.assetsRoot), 'assets');
    });
});

test('private source root accepts one top-level directory symlink and resolves canonical sources through it', async (t) => {
    await withTemporaryDirectories(async (projectRoot, externalRoot) => {
        await mkdir(path.join(externalRoot, 'assets', 'Planets'), { recursive: true });
        try {
            await symlink(externalRoot, path.join(projectRoot, 'private'), process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error: any) {
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
                t.skip(`directory symlink creation is unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        const roots = await inspectPrivateAssetsRoot(projectRoot);
        assert.ok(roots);
        assert.equal(roots.privateRootIsSymlink, true);
        assert.equal(await realpath(roots.realPrivateRoot), await realpath(externalRoot));
        assert.equal(resolveAssetSource('assets/Planets/Hushanyia.png', projectRoot),
            path.join(projectRoot, 'private', 'assets', 'Planets', 'Hushanyia.png'));
        assert.equal((await lstat(path.join(projectRoot, 'private'))).isSymbolicLink(), true);
    });
});

test('private/assets remains a real direct child when private itself is linked', async () => {
    await withTemporaryDirectories(async (projectRoot, externalRoot) => {
        await mkdir(path.join(externalRoot, 'assets-target', 'Planets'), { recursive: true });
        await symlink(path.join(externalRoot, 'assets-target'), path.join(externalRoot, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
        await symlink(externalRoot, path.join(projectRoot, 'private'), process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(inspectPrivateAssetsRoot(projectRoot), /Private asset source root must be a real directory/);
    });
});
