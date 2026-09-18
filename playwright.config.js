import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests/browser',
    testMatch: '*.spec.js',
    use: { baseURL: 'http://127.0.0.1:4179', channel: 'chrome', screenshot: 'only-on-failure' },
    webServer: { command: 'node tests/browser/server.js', url: 'http://127.0.0.1:4179/tests/browser/harness.html', reuseExistingServer: false },
    projects: [
        { name: 'desktop', use: { viewport: { width: 1280, height: 960 } } },
        { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    ],
});
