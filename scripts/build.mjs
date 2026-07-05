import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });

cpSync("src/main.js", "dist/assets/main.js");
cpSync("src/styles.css", "dist/assets/index.css");
for (const image of ["gif.png", "webp.png"]) {
  if (existsSync(`src/${image}`)) {
    cpSync(`src/${image}`, `dist/assets/${image}`);
  }
}
if (existsSync("src/assets")) {
  cpSync("src/assets", "dist/assets", { recursive: true });
}

const html = readFileSync("index.html", "utf8")
  .replace('href="/src/styles.css"', 'href="./assets/index.css"')
  .replace('src="/src/main.js"', 'src="./assets/main.js"')
  .replace('src="/src/webp.png"', 'src="./assets/webp.png"')
  .replace('data-gif-src="/src/gif.png"', 'data-gif-src="./assets/gif.png"')
  .replace('data-webp-src="/src/webp.png"', 'data-webp-src="./assets/webp.png"')
  .replaceAll('src="/src/assets/', 'src="./assets/');

writeFileSync("dist/index.html", html);
