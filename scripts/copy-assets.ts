import { copyFile } from "node:fs/promises";

async function main() {
  for (const name of ["sliding-window.lua", "token-bucket.lua"]) {
    await copyFile(
      `src/rate-limit/stores/${name}`,
      `dist/rate-limit/stores/${name}`,
    );
  }
}

void main();
