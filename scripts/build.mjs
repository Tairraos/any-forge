import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });

cpSync("src/main.js", "dist/assets/main.js");
cpSync("src/styles.css", "dist/assets/index.css");
if (existsSync("src/assets")) {
  cpSync("src/assets", "dist/assets", { recursive: true });
}

const html = readFileSync("index.html", "utf8")
  .replace('href="/src/styles.css"', 'href="./assets/index.css"')
  .replace('src="/src/main.js"', 'src="./assets/main.js"')
  .replaceAll('src="/src/assets/', 'src="./assets/');

writeFileSync("dist/index.html", html);
