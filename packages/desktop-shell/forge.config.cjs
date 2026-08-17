module.exports = {
  outDir: `.electron-out/${process.pid}-${Date.now()}`,
  packagerConfig: {
    asar: true,
    name: "LuckyToken",
    executableName: "LuckyToken",
    extraResource: ["backend"],
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32", "darwin", "linux"],
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        concurrent: false,
        build: [
          {
            entry: "src/main/main.ts",
            config: "vite.main.config.mjs",
            target: "main",
          },
          {
            entry: "src/preload/preload.ts",
            config: "vite.preload.config.mjs",
            target: "preload",
          },
        ],
        renderer: [
          {
            name: "main_window",
            config: "vite.renderer.config.mjs",
          },
        ],
      },
    },
  ],
};
