const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const prefix = core.getInput('prefix');
    const token = core.getInput('token');
    const startVersion = parseInt(core.getInput('start-version'), 10);
    const dryRun = core.getBooleanInput('dry-run');
    const makeLatest = core.getBooleanInput('make-latest');
    const updateMajor = core.getBooleanInput('update-major');
    const assetsInput = core.getMultilineInput('assets');

    if (isNaN(startVersion) || (startVersion !== 0 && startVersion !== 1)) {
      core.setFailed('Input "start-version" must be either 0 or 1.');
      return;
    }

    if (dryRun) {
      core.info('Dry-run mode enabled — no tag or release will be created.');
    }

    const octokit = github.getOctokit(token);
    const context = github.context;

    const pr = context.payload.pull_request;

    if (!pr) {
      core.info(`Event "${context.eventName}" has no pull_request payload — skipping.`);
      return;
    }

    if (context.payload.action === 'closed' && !pr.merged) {
      core.info('Pull request was closed without merging — skipping.');
      return;
    }

    const prTitle = pr.title.trim();
    const prNumber = pr.number;
    const { owner, repo } = context.repo;

    core.info(`PR #${prNumber}: "${prTitle}"`);

    // Determine bump type from PR title suffix (#major, #minor, #patch)
    const bumpType = resolveBumpType(prTitle);
    core.info(`Bump type: ${bumpType}`);

    // Fetch all tags and find the latest semver tag that matches the prefix
    const allTags = await octokit.paginate(octokit.rest.repos.listTags, {
      owner,
      repo,
      per_page: 100,
    });

    const prefixPattern = new RegExp(`^${escapeRegex(prefix)}(\\d+)\\.(\\d+)\\.(\\d+)$`);
    let latestVersion = null;

    for (const tag of allTags) {
      const match = tag.name.match(prefixPattern);
      if (match) {
        const candidate = {
          major: parseInt(match[1], 10),
          minor: parseInt(match[2], 10),
          patch: parseInt(match[3], 10),
        };
        if (!latestVersion || isGreater(candidate, latestVersion)) {
          latestVersion = candidate;
        }
      }
    }

    // Use the start-version as the base when no matching tags exist
    const baseVersion = latestVersion || { major: startVersion, minor: 0, patch: 0 };

    if (!latestVersion) {
      core.info(`No existing tags found with prefix "${prefix}". Using base version ${prefix}${baseVersion.major}.${baseVersion.minor}.${baseVersion.patch}`);
    } else {
      core.info(`Latest version: ${prefix}${baseVersion.major}.${baseVersion.minor}.${baseVersion.patch}`);
    }

    const nextVersion = bumpVersion(baseVersion, bumpType);
    const newTag = `${prefix}${nextVersion.major}.${nextVersion.minor}.${nextVersion.patch}`;
    core.info(`Next version: ${newTag}`);

    const assetPaths = await resolveAssets(assetsInput);
    if (assetPaths.length > 0) {
      core.info(`Assets to upload: ${assetPaths.map((f) => path.basename(f)).join(', ')}`);
    }

    const sha = context.sha;

    if (dryRun) {
      core.info(`[dry-run] Would create tag "${newTag}" at ${sha}`);
      core.info(`[dry-run] Would create release "${newTag}" (make_latest: ${makeLatest})`);
      const majorTag = updateMajor ? `${prefix}${nextVersion.major}` : '';
      if (updateMajor) {
        core.info(`[dry-run] Would upsert major tag "${majorTag}" at ${sha}`);
      }
      for (const filePath of assetPaths) {
        core.info(`[dry-run] Would upload asset "${path.basename(filePath)}"`);
      }
      core.setOutput('new-tag', newTag);
      core.setOutput('major-tag', majorTag);
      core.setOutput('release-url', '');
      core.setOutput('assets-uploaded', assetPaths.map((f) => path.basename(f)).join(','));
      return;
    }

    // Create the git tag ref
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${newTag}`,
      sha,
    });
    core.info(`Tag "${newTag}" created at ${sha}`);

    // Create the GitHub release
    const { data: release } = await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: newTag,
      name: newTag,
      body: buildReleaseBody(prTitle, prNumber, bumpType, newTag),
      draft: false,
      prerelease: false,
      make_latest: makeLatest ? 'true' : 'false',
    });

    core.info(`Release created: ${release.html_url}`);
    core.setOutput('new-tag', newTag);
    core.setOutput('release-url', release.html_url);

    if (updateMajor) {
      await upsertMajorTag({ octokit, owner, repo, prefix, nextVersion, sha });
      core.setOutput('major-tag', `${prefix}${nextVersion.major}`);
    } else {
      core.setOutput('major-tag', '');
    }

    const uploadedNames = await uploadAssets({ octokit, owner, repo, releaseId: release.id, assetPaths });
    core.setOutput('assets-uploaded', uploadedNames.join(','));
  } catch (error) {
    core.setFailed(error.message);
  }
}

/**
 * Detects the bump type from the PR title suffix.
 * Looks for #major, #minor, or #patch (case-insensitive, optional trailing whitespace).
 * Defaults to "minor" if none found.
 */
function resolveBumpType(prTitle) {
  if (/#major\s*$/i.test(prTitle)) return 'major';
  if (/#minor\s*$/i.test(prTitle)) return 'minor';
  if (/#patch\s*$/i.test(prTitle)) return 'patch';
  return 'minor';
}

/**
 * Returns a new version object with the given part bumped.
 * Bumping major resets minor and patch to 0; bumping minor resets patch to 0.
 */
function bumpVersion(version, bumpType) {
  if (bumpType === 'major') {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }
  if (bumpType === 'minor') {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }
  // patch
  return { major: version.major, minor: version.minor, patch: version.patch + 1 };
}

/** Returns true if version a is strictly greater than version b. */
function isGreater(a, b) {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch > b.patch;
}

/** Escapes special regex characters in a string. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Creates or force-updates the major version tag (e.g. v1) to point to the given sha.
 * Tries to create the ref first; if it already exists, updates it with force.
 */
async function upsertMajorTag({ octokit, owner, repo, prefix, nextVersion, sha }) {
  const majorTag = `${prefix}${nextVersion.major}`;
  const ref = `refs/tags/${majorTag}`;
  try {
    await octokit.rest.git.createRef({ owner, repo, ref, sha });
    core.info(`Major tag "${majorTag}" created at ${sha}`);
  } catch (err) {
    if (err.status === 422) {
      await octokit.rest.git.updateRef({ owner, repo, ref: `tags/${majorTag}`, sha, force: true });
      core.info(`Major tag "${majorTag}" updated to ${sha}`);
    } else {
      throw err;
    }
  }
}

/**
 * Resolves a multiline assets input (array of patterns) into a flat list of absolute file paths.
 * Each entry may be a literal path or a glob pattern. Empty entries are ignored.
 * Plain paths are resolved directly; glob characters trigger fs.globSync.
 */
async function resolveAssets(assetPatterns) {
  const files = new Set();
  for (const pattern of assetPatterns) {
    if (!pattern.trim()) continue;
    if (/[*?[{]/.test(pattern)) {
      for (const match of fs.globSync(pattern)) {
        files.add(path.resolve(match));
      }
    } else {
      const resolved = path.resolve(pattern.trim());
      if (fs.existsSync(resolved)) {
        core.info(`Resolved asset: ${resolved}`);
        files.add(resolved);
      } else {
        core.warning(`Asset not found, skipping: ${pattern}`);
      }
    }
  }
  return [...files];
}

/**
 * Uploads an array of file paths as assets to a GitHub release.
 * Returns the list of uploaded filenames.
 */
async function uploadAssets({ octokit, owner, repo, releaseId, assetPaths }) {
  const uploaded = [];
  core.info(`Uploading ${assetPaths.length} asset(s)...`);
  for (const filePath of assetPaths) {
    const name = path.basename(filePath);
    const data = fs.readFileSync(filePath);
    core.info(`Uploading "${name}" (${data.byteLength} bytes)...`);
    await octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: releaseId,
      name,
      data,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': data.byteLength,
      },
    });
    core.info(`Uploaded asset "${name}"`);
    uploaded.push(name);
  }
  return uploaded;
}

/** Builds the release body markdown string. */
function buildReleaseBody(prTitle, prNumber, bumpType, newTag) {
  return [
    `## ${newTag}`,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| PR | #${prNumber} |`,
    `| PR Title | ${prTitle} |`,
    `| Bump Type | \`${bumpType}\` |`,
  ].join('\n');
}

run();
