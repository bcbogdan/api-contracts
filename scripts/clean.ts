import { rm } from "node:fs/promises";

async function main() {
  await rm("dist", { recursive: true, force: true });
}

void main();
