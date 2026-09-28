const path = require("node:path");

const certificateFile = process.env.TOKEN_WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.TOKEN_WINDOWS_CERTIFICATE_PASSWORD;
if ((certificateFile === undefined) !== (certificatePassword === undefined)) {
  throw new Error("Windows signing requires both certificate environment variables");
}

module.exports = {
  appId: "com.keeplearning2026.Token",
  productName: "Token",
  artifactName: "Token-Setup.exe",
  publish: null,
  directories: {
    output: process.env.TOKEN_NSIS_OUTPUT ?? path.join(__dirname, ".electron-out", "make", "nsis"),
  },
  forceCodeSigning: certificateFile !== undefined,
  win: {
    target: "nsis",
    icon: path.join(__dirname, "assets", "icon.ico"),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    runAfterFinish: true,
    installerLanguages: ["zh_CN", "en_US"],
    include: path.join(__dirname, "installer", "catalog-choice.nsh"),
  },
};
