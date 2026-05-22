type PullRequest = {
  number: number;
  state: string;
  draft?: boolean;
  changed_files: number;
  head: {
    sha: string;
    repo: { full_name: string } | null;
  };
  base: {
    ref: string;
    sha: string;
    repo: { full_name: string };
  };
};

type PullRequestFile = {
  filename: string;
  previous_filename?: string;
  status: string;
};

type WorkflowRun = {
  id: number;
  name: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_sha: string;
  path: string;
  pull_requests: Array<{
    number: number;
    head: { sha: string; repo: { full_name: string } | null };
    base: { ref: string; sha: string; repo: { full_name: string } };
  }>;
};

type WorkflowRunsResponse = {
  workflow_runs: WorkflowRun[];
};

const repo = requireEnv("GITHUB_REPOSITORY");
const token = requireEnv("GITHUB_TOKEN");
const prNumber = Number(requireEnv("PR_NUMBER"));
const dryRun = process.env.DRY_RUN === "true";

// Workflow allowlisting is the security boundary: fork PRs may touch broader
// source paths, but this script only approves low-privilege pull_request
// workflows. Keep privileged workflow_run / release / deploy workflows out of
// this set.
const allowedWorkflowPaths = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/visual-pr-capture.yml",
  ".github/workflows/visual-pr-verify.yml",
]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isAllowedChangedPath(path: string): boolean {
  if (isDeniedChangedPath(path)) return false;
  return (
    isDocsPath(path) ||
    path.startsWith("apps/web/") ||
    path.startsWith("apps/daemon/src/") ||
    path.startsWith("apps/daemon/tests/") ||
    path.startsWith("packages/contracts/src/") ||
    path.startsWith("packages/contracts/tests/")
  );
}

function isDeniedChangedPath(path: string): boolean {
  return (
    path.startsWith(".github/") ||
    path.startsWith("scripts/") ||
    path.startsWith("e2e/scripts/") ||
    path.startsWith("nix/") ||
    path.startsWith("tools/pack/") ||
    path.startsWith("apps/packaged/") ||
    path === "package.json" ||
    path.endsWith("/package.json") ||
    path === "pnpm-lock.yaml" ||
    path === "pnpm-workspace.yaml" ||
    path === "flake.nix" ||
    path === "flake.lock" ||
    /(^|\/)(next|vite|vitest|playwright|astro|postcss|tailwind|eslint|prettier|tsconfig|wrangler|electron-builder)\.[^.]+$/.test(
      path,
    ) ||
    path.endsWith("esbuild.config.mjs") ||
    path.endsWith("esbuild.config.ts")
  );
}

function isDocsPath(path: string): boolean {
  return (
    path === "README.md" ||
    path === "README.zh-CN.md" ||
    path === "CONTRIBUTING.md" ||
    path === "CONTRIBUTING.zh-CN.md" ||
    path === "QUICKSTART.md" ||
    path.startsWith("docs/")
  );
}

function changedPathSet(file: PullRequestFile): string[] {
  return [file.filename, file.previous_filename].filter((path): path is string => Boolean(path));
}

function runBelongsToPullRequest(run: WorkflowRun, pull: PullRequest): boolean {
  return run.pull_requests.some((runPull) => {
    return (
      runPull.number === pull.number &&
      runPull.head.sha === pull.head.sha &&
      runPull.head.repo?.full_name === pull.head.repo?.full_name &&
      runPull.base.ref === pull.base.ref &&
      runPull.base.sha === pull.base.sha &&
      runPull.base.repo.full_name === pull.base.repo.full_name
    );
  });
}

async function github<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "open-design-fork-pr-workflow-approver",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${body}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function githubPaginated<T>(path: string): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const items = await github<T[]>(`${path}${separator}per_page=100&page=${page}`);
    results.push(...items);
    if (items.length < 100) return results;
  }
}

async function approveRun(run: WorkflowRun): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] would approve workflow run ${run.id} (${run.name ?? run.path})`);
    return;
  }

  await github<void>(`/repos/${repo}/actions/runs/${run.id}/approve`, { method: "POST" });
  console.log(`Approved workflow run ${run.id} (${run.name ?? run.path})`);
}

async function main(): Promise<void> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR_NUMBER: ${process.env.PR_NUMBER ?? ""}`);
  }

  const pull = await github<PullRequest>(`/repos/${repo}/pulls/${prNumber}`);
  if (pull.state !== "open") {
    console.log(`Skipping PR #${prNumber}: state is ${pull.state}.`);
    return;
  }
  if (pull.draft) {
    console.log(`Skipping PR #${prNumber}: draft PR.`);
    return;
  }
  if (!pull.head.repo) {
    console.log(`Skipping PR #${prNumber}: head repository is unavailable.`);
    return;
  }
  if (pull.head.repo.full_name === pull.base.repo.full_name) {
    console.log(`Skipping PR #${prNumber}: not a fork PR.`);
    return;
  }

  const files = await githubPaginated<PullRequestFile>(`/repos/${repo}/pulls/${prNumber}/files`);
  if (files.length !== pull.changed_files) {
    console.log(
      `Skipping PR #${prNumber}: GitHub returned ${files.length} changed files, but PR reports ${pull.changed_files}.`,
    );
    return;
  }

  const latestPull = await github<PullRequest>(`/repos/${repo}/pulls/${prNumber}`);
  if (latestPull.state !== "open") {
    console.log(`Skipping PR #${prNumber}: state changed to ${latestPull.state} while evaluating workflow approval.`);
    return;
  }
  if (latestPull.draft) {
    console.log(`Skipping PR #${prNumber}: PR became draft while evaluating workflow approval.`);
    return;
  }
  if (
    latestPull.head.sha !== pull.head.sha ||
    latestPull.base.sha !== pull.base.sha ||
    latestPull.base.ref !== pull.base.ref ||
    latestPull.head.repo?.full_name !== pull.head.repo?.full_name
  ) {
    console.log(`Skipping PR #${prNumber}: PR head/base changed while evaluating workflow approval.`);
    return;
  }

  const blockedPaths = files.flatMap((file) => changedPathSet(file).filter((path) => !isAllowedChangedPath(path)));

  if (blockedPaths.length > 0) {
    console.log(`Skipping PR #${prNumber}: changed paths are outside the auto-approval allowlist.`);
    for (const path of blockedPaths) console.log(`- ${path}`);
    return;
  }

  const runs = await github<WorkflowRunsResponse>(
    `/repos/${repo}/actions/runs?event=pull_request&head_sha=${pull.head.sha}&status=action_required&per_page=100`,
  );
  const pendingRuns = runs.workflow_runs.filter((run) => {
    return (
      run.head_sha === pull.head.sha &&
      run.event === "pull_request" &&
      run.status === "action_required" &&
      allowedWorkflowPaths.has(run.path) &&
      runBelongsToPullRequest(run, pull)
    );
  });

  if (pendingRuns.length === 0) {
    console.log(`No action_required pull_request workflow runs found for PR #${prNumber} at ${pull.head.sha}.`);
    return;
  }

  for (const run of pendingRuns) await approveRun(run);
}

await main();
