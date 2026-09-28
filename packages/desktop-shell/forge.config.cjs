const path = require("node:path");

const iconDirectory = path.resolve(__dirname, "assets");
const iconBase = path.join(iconDirectory, "icon");

module.exports = {
  outDir: `.electron-out/${process.pid}-${Date.now()}`,
  packagerConfig: {
    asar: true,
    name: "Token",
    executableName: "Token",
    icon: iconBase,
    extraResource: [
      "backend",
      path.join(iconDirectory, "icon.png"),
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux"],
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
