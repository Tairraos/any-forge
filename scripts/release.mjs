import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = process.cwd();
const requestedVersion = process.argv[2]?.trim();

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function run(command, args) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function requireSemver(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`版本号格式不正确: ${version}`);
  }
}

function replaceFile(path, replacer) {
  const before = readFileSync(path, "utf8");
  const after = replacer(before);
  if (after !== before) {
    writeFileSync(path, after);
  }
}

function updateVersion(version) {
  requireSemver(version);

  const packageJsonPath = "package.json";
  const packageJson = readJson(packageJsonPath);
  packageJson.version = version;
  writeJson(packageJsonPath, packageJson);

  replaceFile("src-tauri/Cargo.toml", (content) =>
    content.replace(/^version = ".*"$/m, `version = "${version}"`),
  );

  const tauriConfigPath = "src-tauri/tauri.conf.json";
  const tauriConfig = readJson(tauriConfigPath);
  tauriConfig.version = version;
  for (const windowConfig of tauriConfig.app?.windows ?? []) {
    if (windowConfig.title) {
      windowConfig.title = `${tauriConfig.productName} ${version}`;
    }
  }
  writeJson(tauriConfigPath, tauriConfig);

  replaceFile("index.html", (content) =>
    content.replace(/<title>.*<\/title>/, `<title>${tauriConfig.productName} ${version}</title>`),
  );

  if (existsSync("README.md")) {
    replaceFile("README.md", (content) =>
      content.replace(/badge\/version-[^-]+-/g, `badge/version-${version}-`),
    );
  }
}

function currentVersion() {
  return readJson("src-tauri/tauri.conf.json").version;
}

function productName() {
  return readJson("src-tauri/tauri.conf.json").productName;
}

function movePath(from, to) {
  rmSync(to, { recursive: true, force: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function releaseDmgName(dmgFile, name, version) {
  const escapedVersion = version.replaceAll(".", "\\.");
  const match = basename(dmgFile).match(new RegExp(`_${escapedVersion}_(.+)\\.dmg$`));
  const arch = match?.[1];
  return arch ? `${name}-${version}-${arch}.dmg` : `${name}-${version}.dmg`;
}

function archName() {
  if (process.arch === "arm64") {
    return "aarch64";
  }
  if (process.arch === "x64") {
    return "x64";
  }
  return process.arch;
}

function createSimpleDmg(version) {
  const name = productName();
  const appPath = join("src-tauri", "target", "release", "bundle", "macos", `${name}.app`);
  const dmgDir = join("src-tauri", "target", "release", "bundle", "dmg");
  const dmgPath = join(dmgDir, `${name}_${version}_${archName()}.dmg`);
  const stagingDir = mkdtempSync(join(tmpdir(), "any-forge-dmg-"));

  try {
    mkdirSync(dmgDir, { recursive: true });
    for (const file of readdirSync(dmgDir)) {
      if (file.startsWith("rw.") || file === basename(dmgPath)) {
        rmSync(join(dmgDir, file), { force: true });
      }
    }
    cpSync(appPath, join(stagingDir, `${name}.app`), { recursive: true });
    symlinkSync("/Applications", join(stagingDir, "Applications"));
    run("hdiutil", [
      "makehybrid",
      "-hfs",
      "-hfs-volume-name",
      name,
      "-o",
      dmgPath,
      stagingDir,
    ]);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function collectReleaseFiles(version) {
  const name = productName();
  const bundleDir = join("src-tauri", "target", "release", "bundle");
  const appPath = join(bundleDir, "macos", `${name}.app`);
  const dmgDir = join(bundleDir, "dmg");

  if (!existsSync(appPath)) {
    throw new Error(`找不到 App 产物: ${appPath}`);
  }
  if (!existsSync(dmgDir)) {
    throw new Error(`找不到 DMG 目录: ${dmgDir}`);
  }

  const dmgFiles = readdirSync(dmgDir)
    .filter((file) => file.endsWith(".dmg") && !file.startsWith("rw."))
    .map((file) => join(dmgDir, file));
  if (dmgFiles.length === 0) {
    throw new Error(`找不到 DMG 产物: ${dmgDir}`);
  }

  rmSync("release", { recursive: true, force: true });
  mkdirSync("release", { recursive: true });

  const releaseApp = join("release", `${name}-${version}.app`);
  movePath(appPath, releaseApp);
  console.log(`\nApp: ${releaseApp}`);

  for (const dmgFile of dmgFiles) {
    const releaseDmg = join("release", releaseDmgName(dmgFile, name, version));
    movePath(dmgFile, releaseDmg);
    console.log(`DMG: ${releaseDmg}`);
  }
}

function cleanProcessFiles() {
  for (const path of [
    "dist",
    join("src-tauri", "target"),
    join("src-tauri", "gen"),
    join("src-tauri", "icons", "64x64.png"),
    join("src-tauri", "icons", "android"),
    join("src-tauri", "icons", "ios"),
    ".DS_Store",
    join("src", ".DS_Store"),
    join("src", "assets", ".DS_Store"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
}

if (requestedVersion) {
  console.log(`更新版本号到 ${requestedVersion}`);
  updateVersion(requestedVersion);
}

const version = currentVersion();
console.log(`准备发布 AnyForge ${version}`);

run("pnpm", ["tauri", "icon", "src-tauri/icons/app-icon.png"]);
run("pnpm", ["tauri", "build", "--bundles", "app"]);
createSimpleDmg(version);
collectReleaseFiles(version);
cleanProcessFiles();

console.log("\n发布包已生成。");
