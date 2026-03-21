const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const prefix = core.getInput('prefix');
    const token = core.getInput('token');
    const startVersion = parseInt(core.getInput('start-version'), 10);
    const dryRun = core.getBooleanInput('dry-run');
    const makeLatest = core.getBooleanInput('make-latest');
    const shaInput = core.getInput('sha');

    if (isNaN(startVersion) || (startVersion !== 0 && startVersion !== 1)) {
      core.setFailed('Input "start-version" must be either 0 or 1.');
      return;
    }

    if (dryRun) {
      core.info('Dry-run mode enabled — no tag or release will be created.');
    }

    const octokit = github.getOctokit(token);
    const context = github.context;

    if (context.eventName !== 'pull_request') {
      core.setFailed('This action must be triggered by a pull_request event.');
      return;
    }

    const pr = context.payload.pull_request;
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

    const sha = shaInput || context.sha;
    core.info(`Tagging SHA: ${sha}${shaInput ? ' (overridden via sha input)' : ''}`);

    if (dryRun) {
      core.info(`[dry-run] Would create tag "${newTag}" at ${sha}`);
      core.info(`[dry-run] Would create release "${newTag}" (make_latest: ${makeLatest})`);
      core.setOutput('new-tag', newTag);
      core.setOutput('release-url', '');
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
