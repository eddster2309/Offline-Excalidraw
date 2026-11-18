import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    viewport: { width: 1280, height: 800 },
    // Service workers bypass context.route(); block them so every request is observable.
    serviceWorkers: "block",
  },
});
