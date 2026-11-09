import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

const rules = [
  { name: "workspace dependency", pattern: new RegExp("workspace" + ":") },
  {
    name: "local user path",
    pattern: new RegExp("/(?:Users|home)/" + "[^/\\s]+/"),
  },
  {
    name: "private key",
    pattern: new RegExp(
      "-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    ),
  },
  {
    name: "GitHub credential",
    pattern: new RegExp(
      "gh[pousr]_" + "[A-Za-z0-9]{30,}|github_pat_" + "[A-Za-z0-9_]{40,}",
    ),
  },
  {
    name: "AWS access key",
    pattern: new RegExp("(?:AKIA|ASIA)" + "[A-Z0-9]{16}"),
  },
  {
    name: "credential-bearing URL",
    pattern: new RegExp("[a-z]+://" + "[^\\s/:]+:[^\\s/@]+@", "i"),
  },
];
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
if (!files.length)
  throw new Error("Stage files before checking the public repository");
const failures: string[] = [];
for (const path of files) {
  if (/(^|\/)(?:\.env(?:\..*)?|node_modules|\.git)(?:\/|$)/.test(path))
    failures.push(`${path}: excluded file`);
  if (!lstatSync(path).isFile()) {
    failures.push(`${path}: not a regular file`);
    continue;
  }
  const content = readFileSync(path, "utf8");
  for (const rule of rules)
    if (rule.pattern.test(content)) failures.push(`${path}: ${rule.name}`);
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(
  `Public-repository guardrails passed for ${files.length} tracked files.`,
);
