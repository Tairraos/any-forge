import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

export function writeJson(path, data) {
  writeFileSync(resolve(root, path), `${JSON.stringify(data, null, 2)}\n`);
}

export function currentVersion() {
  return readJson("package.json").version;
}

export function patchVersion(nextVersion) {
  assertVersion(nextVersion);
  const current = currentVersion();
  if (compareVersions(nextVersion, current) <= 0) {
    throw new Error(`版本号必须高于当前版本 ${current}: ${nextVersion}`);
  }

  const packageJson = readJson("package.json");
  packageJson.version = nextVersion;
  writeJson("package.json", packageJson);

  replaceInFile("src-tauri/Cargo.toml", /^version = ".+"/m, `version = "${nextVersion}"`);
  replaceInFile(
    "src-tauri/Cargo.lock",
    new RegExp(`(\\[\\[package\\]\\]\\nname = "${packageJson.name}"\\nversion = ")[^"]+(")`),
    `$1${nextVersion}$2`,
  );

  const tauriConfig = readJson("src-tauri/tauri.conf.json");
  const baseTitle = stripVersion(tauriConfig.app?.windows?.[0]?.title || tauriConfig.productName);
  tauriConfig.version = nextVersion;
  for (const windowConfig of tauriConfig.app?.windows ?? []) {
    windowConfig.title = `${baseTitle} ${nextVersion}`;
  }
  writeJson("src-tauri/tauri.conf.json", tauriConfig);

  if (existsSync(resolve(root, "index.html"))) {
    replaceInFile("index.html", /<title>.*<\/title>/, `<title>${baseTitle} ${nextVersion}</title>`);
  }
  if (existsSync(resolve(root, "README.md"))) {
    replaceInFile("README.md", /badge\/version-[^-]+-/g, `badge/version-${nextVersion}-`);
  }
  if (existsSync(resolve(root, "src-tauri/src/lib.rs"))) {
    replaceInFile(
      "src-tauri/src/lib.rs",
      new RegExp(`const APP_USER_AGENT: &str = "${packageJson.name}/[^"]+";`),
      `const APP_USER_AGENT: &str = "${packageJson.name}/${nextVersion}";`,
    );
  }
}

export function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`版本号格式不正确: ${version}`);
  }
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function stripVersion(title) {
  return title.replace(/\s+\d+\.\d+\.\d+$/, "");
}

function replaceInFile(path, pattern, replacement) {
  const fullPath = resolve(root, path);
  const before = readFileSync(fullPath, "utf8");
  const after = before.replace(pattern, replacement);
  if (after !== before) writeFileSync(fullPath, after);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const nextVersion = process.argv.slice(2).find((arg) => arg !== "--");
  if (!nextVersion) throw new Error("用法: pnpm run patch -- x.y.z");
  patchVersion(nextVersion);
  console.log(`版本已更新到 ${nextVersion}`);
}
