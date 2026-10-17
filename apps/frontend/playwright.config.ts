import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: { baseURL: "http://127.0.0.1:3105", viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    screenshot: "only-on-failure" },
  webServer: { command: "npm run dev -- --port 3105", url: "http://127.0.0.1:3105/dashboard",
    reuseExistingServer: !process.env.CI, timeout: 120000 },
});
