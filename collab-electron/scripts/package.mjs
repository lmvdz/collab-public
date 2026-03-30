import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const builderArgs = ["--publish", "never"];
const env = { ...process.env };
const cwd = process.cwd();

// Load .env.local (same approach as notarize.cjs) so GH_TOKEN and other
// credentials are available without requiring a manual export.
const envLocalPath = join(cwd, ".env.local");
if (existsSync(envLocalPath)) {
  for (const line of readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length > 0 && !(key.trim() in env)) {
      env[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
}

// The renderer build (~7 700 modules) exceeds the default V8 heap limit.
if (!env.NODE_OPTIONS?.includes("--max-old-space-size")) {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim();
}

const shouldPublish = args.includes("--publish");

if (shouldPublish && process.platform !== "darwin") {
  builderArgs.splice(0, builderArgs.length, "--publish", "always");
}

if (args.includes("--no-sign")) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  env.SKIP_NOTARIZE = "true";
  builderArgs.push("-c.mac.identity=null");
}

function run(command, commandArgs, extraEnv = env) {
  const result = spawnSync(
    command,
    commandArgs,
    {
      stdio: "inherit",
      cwd,
      env: extraEnv,
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function binPath(name) {
  return join(
    cwd,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.exe` : name,
  );
}

function detectMismatchedToolchain(expectedName) {
  const expected = binPath(expectedName);
  const opposite = join(
    cwd,
    "node_modules",
    ".bin",
    process.platform === "win32" ? expectedName : `${expectedName}.exe`,
  );

  if (existsSync(expected)) {
    return expected;
  }

  if (existsSync(opposite)) {
    console.error(
      `Detected ${process.platform === "win32" ? "non-Windows" : "Windows"}-installed tooling in a ${process.platform} packaging environment.`,
    );
    console.error(
      "Run `bun run clean:deep` and reinstall dependencies in a native checkout for this OS before packaging.",
    );
    process.exit(1);
  }

  console.error(`Missing local binary: ${expected}`);
  console.error("Run `bun install` in this checkout before packaging.");
  process.exit(1);
}

// Skip electron-builder's native module rebuild. node-pty ships N-API
// prebuilds for every platform, so we copy those into build/Release instead of
// compiling from source (which fails on Windows — winpty's GetCommitHash.bat
// is missing from the npm tarball).
builderArgs.push("-c.npmRebuild=false");

function targetArchitectures() {
  const arches = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--arch" && args[i + 1]) {
      arches.push(...args[i + 1].split(","));
      i++;
    }
  }
  if (arches.length > 0) return arches;

  // Windows ships both x64 and arm64 installers by default.
  if (process.platform === "win32") return ["x64", "arm64"];

  // Fall back to the arch configured in package.json for this platform.
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const key = { win32: "win", darwin: "mac", linux: "linux" }[process.platform];
  const targets = pkg.build?.[key]?.target;
  if (Array.isArray(targets) && targets[0]?.arch) return [targets[0].arch];

  return [process.arch];
}

function installNodePtyPrebuilds(arch) {
  const tag = `${process.platform}-${arch}`;
  const src = join(cwd, "node_modules", "node-pty", "prebuilds", tag);
  const dst = join(cwd, "node_modules", "node-pty", "build", "Release");

  if (!existsSync(src)) {
    console.error(`No node-pty prebuilds for ${tag}`);
    process.exit(1);
  }

  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`• node-pty prebuilds (${tag}) → build/Release`);
}

const electronVite = detectMismatchedToolchain("electron-vite");
const electronBuilder = detectMismatchedToolchain("electron-builder");

// Vite build is arch-independent — run once.
run(electronVite, ["build"]);

// Package once per target arch with the matching node-pty prebuilds.
for (const arch of targetArchitectures()) {
  installNodePtyPrebuilds(arch);
  run(electronBuilder, [...builderArgs, `--${arch}`]);
}

// On macOS, use upload-to-github.cjs instead of electron-builder's publisher
// to avoid type-mismatch errors when the release already exists (e.g. created
// by the Windows build as a pre-release).
if (shouldPublish && process.platform === "darwin") {
  run("node", [join(cwd, "scripts", "upload-to-github.cjs")]);
}
