import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const root = process.cwd();
const requestedPlatform = process.argv.find((arg) => arg.startsWith("--platform="))?.split("=", 2)[1];
const targetPlatform = requestedPlatform || process.platform;
const escapeXml = (value) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const template = targetPlatform === "win32"
  ? join(root, "ops", "windows", "com.example.content-harness.xml.template")
  : targetPlatform === "darwin"
    ? join(root, "ops", "launchd", "com.news-journey.text-edition.plist.template")
    : null;

if (!template) throw new Error(`No schedule template for ${targetPlatform}; supported platforms are macOS and Windows`);
// The scheduled job must run the same Node that rendered it: launchd's own PATH has no Node 22 (or any Node).
const values = { __PROJECT_ROOT__: root, __NODE__: process.execPath, __NODE_DIR__: dirname(process.execPath), __HOME__: homedir() };
process.stdout.write(Object.entries(values).reduce((text, [name, value]) => text.replaceAll(name, escapeXml(value)), readFileSync(template, "utf8")));
