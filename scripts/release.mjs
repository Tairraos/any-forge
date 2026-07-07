import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { currentVersion, patchVersion, readJson, root } from "./patch-version.mjs";

process.chdir(root);

const requestedVersion = process.argv.slice(2).find((arg) => arg !== "--")?.trim();
if (requestedVersion) patchVersion(requestedVersion);

const version = currentVersion();
const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const productName = tauriConfig.productName;
const bundleDir = join(root, "src-tauri", "target", "release", "bundle");
const releaseDir = join(root, "release");

try {
  rmSync(bundleDir, { recursive: true, force: true });
  cleanIcons();
  run("pnpm", ["tauri", "icon", "src-tauri/icons/app-icon.png"]);

  try {
    run("pnpm", ["tauri", "build"]);
  } catch (error) {
    if (!hasBuildOutput()) throw error;
    console.warn("tauri build 没有完整结束，继续整理已生成的发布产物。");
  }

  if (process.platform === "darwin" && macAppPath() && !findFiles(join(bundleDir, "dmg"), ".dmg").length) {
    createSimpleDmg();
  }

  const outputs = collectReleaseFiles();
  assertExpectedOutputs(outputs);
  console.log("\n发布包已生成：");
  for (const output of outputs) console.log(output);
} finally {
  cleanProcessFiles();
}

function run(command, args, options = {}) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd: options.cwd || root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function archName() {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x64";
  return process.arch;
}

function hasBuildOutput() {
  return Boolean(macAppPath() || windowsExecutablePath());
}

function macAppPath() {
  const path = join(bundleDir, "macos", `${productName}.app`);
  return existsSync(path) ? path : "";
}

function windowsExecutablePath() {
  const path = join(root, "src-tauri", "target", "release", `${packageJson.name}.exe`);
  return existsSync(path) ? path : "";
}

function createSimpleDmg() {
  const appPath = macAppPath();
  if (!appPath) return;
  const dmgDir = join(bundleDir, "dmg");
  const dmgPath = join(dmgDir, `${productName}_${version}_${archName()}.dmg`);
  const stagingDir = mkdtempSync(join(tmpdir(), `${packageJson.name}-dmg-`));

  try {
    mkdirSync(dmgDir, { recursive: true });
    cpSync(appPath, join(stagingDir, `${productName}.app`), { recursive: true });
    symlinkSync("/Applications", join(stagingDir, "Applications"));
    run("hdiutil", ["makehybrid", "-hfs", "-hfs-volume-name", productName, "-o", dmgPath, stagingDir]);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function collectReleaseFiles() {
  mkdirSync(releaseDir, { recursive: true });
  const outputs = [];

  const appPath = macAppPath();
  if (appPath) outputs.push(movePath(appPath, releaseName(".app")));

  const winExe = windowsExecutablePath();
  if (winExe) outputs.push(movePath(winExe, releaseName(".exe")));

  for (const dmgFile of findFiles(join(bundleDir, "dmg"), ".dmg")) {
    if (!basename(dmgFile).startsWith("rw.")) outputs.push(movePath(dmgFile, releaseName(".dmg")));
  }
  for (const installer of [
    ...findFiles(join(bundleDir, "nsis"), ".exe"),
    ...findFiles(join(bundleDir, "msi"), ".msi"),
  ]) {
    outputs.push(movePath(installer, releaseName(extname(installer), "setup")));
  }
  for (const linuxPackage of [
    ...findFiles(join(bundleDir, "appimage"), ".AppImage"),
    ...findFiles(join(bundleDir, "deb"), ".deb"),
    ...findFiles(join(bundleDir, "rpm"), ".rpm"),
  ]) {
    outputs.push(movePath(linuxPackage, releaseName(extname(linuxPackage))));
  }

  return outputs;
}

function releaseName(extension, suffix = "") {
  const parts = [productName, version, archName()];
  if (suffix) parts.push(suffix);
  return join(releaseDir, `${parts.join("-")}${extension}`);
}

function movePath(from, to) {
  rmSync(to, { recursive: true, force: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  return to;
}

function findFiles(dir, extension) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? findFiles(path, extension) : [path];
    })
    .filter((path) => path.endsWith(extension))
    .sort();
}

function assertExpectedOutputs(outputs) {
  if (process.platform === "darwin" && (!outputs.some((file) => file.endsWith(".app")) || !outputs.some((file) => file.endsWith(".dmg")))) {
    throw new Error("macOS 发布包必须包含 .app 和 .dmg");
  }
  if (process.platform === "win32" && (!outputs.some((file) => file.endsWith(".exe") && !file.includes("-setup.")) || !outputs.some((file) => file.includes("-setup.")))) {
    throw new Error("Windows 发布包必须包含可执行文件和安装文件");
  }
}

function cleanIcons() {
  const iconDir = join(root, "src-tauri", "icons");
  for (const entry of readdirSync(iconDir)) {
    if (!["app-icon.png", "icon.png"].includes(entry)) {
      rmSync(join(iconDir, entry), { recursive: true, force: true });
    }
  }
}

function cleanProcessFiles() {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  rmSync(join(root, "src-tauri", "target"), { recursive: true, force: true });
  rmSync(join(root, "src-tauri", "gen"), { recursive: true, force: true });
  cleanIcons();
}
