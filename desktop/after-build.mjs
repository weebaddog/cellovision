// After a build: a note beside the installer ({ version, sha256 }), which the release signer
// (cellocloud/server/tools/sign-release.mjs) checks before offering it as an update.
//   node after-build.mjs [dist folder] [installer name]
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const dir = process.argv[2] || "dist";
const name = process.argv[3] || "Cellovision-Setup.exe";
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ version, file: name, sha256 }, null, 1));
console.log(`${name} ${version} ${sha256.slice(0, 16)}…`);
