import { defineConfig } from 'vite';
import { createAssetWatcherPlugin } from './scripts/watch-assets.mjs';

export default defineConfig({
    plugins: [createAssetWatcherPlugin()],
    server: {
        watch: {
            ignorePermissionErrors: false
        }
    }
});
