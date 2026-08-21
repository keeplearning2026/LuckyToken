const certificateFile = process.env.LUCKYTOKEN_WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.LUCKYTOKEN_WINDOWS_CERTIFICATE_PASSWORD;

if ((certificateFile === undefined) !== (certificatePassword === undefined)) {
  throw new Error(
    "Windows signing requires both LUCKYTOKEN_WINDOWS_CERTIFICATE_FILE and LUCKYTOKEN_WINDOWS_CERTIFICATE_PASSWORD",
  );
}

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
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "LuckyToken",
        authors: "keeplearning2026",
        description: "Local AI model gateway and desktop management application.",
        exe: "LuckyToken.exe",
        setupExe: "LuckyToken-Setup.exe",
        noMsi: true,
        ...(certificateFile === undefined
          ? {}
          : { certificateFile, certificatePassword }),
      },
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
