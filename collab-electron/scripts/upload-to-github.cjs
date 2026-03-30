#!/usr/bin/env node

// Upload build artifacts to GitHub Releases.
// Requires GH_TOKEN or GITHUB_TOKEN environment variable.

const { Octokit } = require("@octokit/rest");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Load .env.local so GH_TOKEN can live alongside other credentials.
const envLocalPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length > 0 && !(key.trim() in process.env)) {
      process.env[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
}

const pkg = require("../package.json");
const version = pkg.version;
const product = pkg.build.productName;
const owner = pkg.build.publish[0].owner;
const repo = pkg.build.publish[0].repo;

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error("No GitHub token. Set GH_TOKEN or GITHUB_TOKEN.");
  process.exit(1);
}

const distDir = path.join(__dirname, "..", pkg.build.directories.output);
const zipName = `${product}-${version}-arm64-mac.zip`;
const zipPath = path.join(distDir, zipName);

function sha512Base64(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha512").update(buf).digest("base64");
}

// Regenerate latest-mac.yml from the actual zip on disk.
// electron-builder's PublishManager.awaitTasks() may overwrite the yml
// after the build, so regenerate it from the actual zip on disk.
function regenerateYml() {
  const ymlPath = path.join(distDir, "latest-mac.yml");
  const zipStats = fs.statSync(zipPath);
  const zipHash = sha512Base64(zipPath);

  const blockmapPath = zipPath + ".blockmap";
  const blockMapSize = fs.existsSync(blockmapPath)
    ? fs.statSync(blockmapPath).size
    : 0;
  const blockMapLine =
    blockMapSize > 0 ? `\n    blockMapSize: ${blockMapSize}` : "";

  const yml = [
    `version: ${version}`,
    "files:",
    `  - url: ${zipName}`,
    `    sha512: ${zipHash}`,
    `    size: ${zipStats.size}${blockMapLine}`,
    `path: ${zipName}`,
    `sha512: ${zipHash}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");

  fs.writeFileSync(ymlPath, yml);
  console.log(`Regenerated latest-mac.yml (sha512: ${zipHash.slice(0, 16)}...)`);
  return ymlPath;
}

function resolveArtifact(label, artifactPath, optional) {
  const resolved = path.resolve(artifactPath);
  if (!fs.existsSync(resolved)) {
    if (optional) return null;
    throw new Error(`${label} not found: ${resolved}`);
  }
  return resolved;
}

const artifacts = (() => {
  try {
    const ymlPath = regenerateYml();

    const list = [
      { label: "ZIP", path: resolveArtifact("ZIP", zipPath) },
      { label: "latest-mac.yml", path: ymlPath },
    ];

    const bm = resolveArtifact(
      "Blockmap",
      zipPath + ".blockmap",
      true,
    );
    if (bm) {
      list.push({ label: "Blockmap", path: bm });
    } else {
      console.warn("No blockmap found -- delta updates disabled");
    }

    return list;
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();

const octokit = new Octokit({ auth: token });

async function uploadAsset(release, assetPath) {
  const fileName = path.basename(assetPath);
  const existing = release.assets.find((a) => a.name === fileName);

  if (existing) {
    console.log(`Replacing existing asset ${fileName}...`);
    await octokit.repos.deleteReleaseAsset({
      owner,
      repo,
      asset_id: existing.id,
    });
  }

  const stats = fs.statSync(assetPath);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`Uploading ${fileName} (${sizeMB} MB)...`);

  await octokit.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: release.id,
    name: fileName,
    data: fs.readFileSync(assetPath),
    headers: {
      "content-length": stats.size,
      "content-type": fileName.endsWith(".yml")
        ? "text/x-yaml"
        : "application/octet-stream",
    },
  });

  console.log(`Uploaded ${fileName}`);
}

async function main() {
  const tag = `v${version}`;
  console.log(`Uploading to ${owner}/${repo} ${tag}`);

  let release;
  let wasDraft = true;
  try {
    const { data } = await octokit.repos.getReleaseByTag({
      owner,
      repo,
      tag,
    });
    release = data;
    wasDraft = release.draft;
    console.log(`Found existing release: ${release.name || tag}`);

    if (!wasDraft) {
      console.log("Converting to draft while uploading...");
      await octokit.repos.updateRelease({
        owner,
        repo,
        release_id: release.id,
        draft: true,
      });
    }
  } catch (err) {
    if (err.status === 404) {
      console.log(`Creating draft release ${tag}...`);
      const { data } = await octokit.repos.createRelease({
        owner,
        repo,
        tag_name: tag,
        name: `Collaborator ${version}`,
        draft: true,
        prerelease: false,
      });
      release = data;
      console.log(`Created draft release: ${release.html_url}`);
    } else {
      throw err;
    }
  }

  for (const artifact of artifacts) {
    await uploadAsset(release, artifact.path);
  }

  if (!wasDraft) {
    console.log("Re-publishing release...");
    await octokit.repos.updateRelease({
      owner,
      repo,
      release_id: release.id,
      draft: false,
    });
  }

  console.log(`\nUploaded to ${release.html_url}`);
  console.log(
    wasDraft
      ? "Review and publish the draft release when ready."
      : "Release re-published.",
  );
}

main().catch((err) => {
  console.error("Upload failed:", err.message);
  if (err.response) console.error("Response:", err.response.data);
  process.exit(1);
});
