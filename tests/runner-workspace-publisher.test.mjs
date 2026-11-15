import assert from "node:assert/strict"
import { publicationHeadBranch, publicationPullBody, publishRunnerWorkspace } from "../.github/scripts/run-agent-task/runner-workspace-publisher.mjs"

const request = { target_repo: "owner/repo", workload: { id: "run-1", label: "Update" }, runner_workspace: { enabled: true, repo: "owner/repo", base: "main", branch_prefix: "wp-codebox/agent-task/" }, access: { allowed_repos: ["owner/repo"] } }
const publicationFiles = [{ path: "README.md", mode: "100644", content: Buffer.from("changed\n").toString("base64"), deleted: false }]

function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body } }
function fetchMock(existing = false, base = "main", defaultBranch, pull = existing, comparison = "ahead", pullBase = base, freshExisting = false, freshPull = false) {
  const calls = []
  return { calls, fetch: async (url, init) => {
    calls.push([url, init.method, init.body ? JSON.parse(init.body) : undefined])
    const parsed = new URL(url)
    const path = parsed.pathname.replace("/repos/owner/repo", "")
    if (path === "") return response(200, { default_branch: defaultBranch })
    if (path === `/git/ref/heads/${base}`) return response(200, { object: { sha: "base" } })
    if (path === "/git/commits/base" || path === "/git/commits/old" || path === "/git/commits/collision") return response(200, { tree: { sha: path.endsWith("base") ? "tree" : "prior-tree" } })
    if (path.includes("/git/ref/heads/wp-codebox/agent-task/run-1-base")) return freshExisting ? response(200, { object: { sha: "collision" } }) : response(404, {})
    if (path.includes("/git/ref/heads/wp-codebox/agent-task/run-1")) return existing ? response(200, { object: { sha: "old" } }) : response(404, {})
    if (path === "/compare/base...old") return response(200, { status: comparison, merge_base_commit: { sha: "base" } })
    if (path === "/compare/base...collision") return response(200, { status: comparison, merge_base_commit: { sha: "base" } })
    if (path === "/git/blobs") return response(201, { sha: "blob" })
    if (path === "/git/trees") return response(201, { sha: "next-tree" })
    if (path === "/git/commits") return response(201, { sha: "commit" })
    if (path === "/git/refs") return response(201, {})
    if (path.includes("/git/refs/heads/")) return response(200, {})
    if (path === "/pulls" && parsed.search) {
      const head = parsed.searchParams.get("head")?.split(":").slice(1).join(":")
      const hasPull = head?.endsWith("-base") ? freshPull : pull
      return response(200, hasPull ? [{ number: 4, html_url: "https://github.com/owner/repo/pull/4", base: { repo: { full_name: "owner/repo" }, ref: pullBase }, head: { repo: { full_name: "owner/repo" }, ref: head } }] : [])
    }
    if (path === "/pulls") return response(201, { number: 5, html_url: "https://github.com/owner/repo/pull/5", base: { repo: { full_name: "owner/repo" }, ref: base }, head: { repo: { full_name: "owner/repo" }, ref: init.body ? JSON.parse(init.body).head : "wp-codebox/agent-task/run-1" } })
    throw new Error(`unexpected ${path}`)
  } }
}
{
  const nonMainRequest = { ...request, runner_workspace: { ...request.runner_workspace, base: "release", base_branch: "legacy" } }
  const mock = fetchMock(false, "release")
  const result = await publishRunnerWorkspace({ request: nonMainRequest, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.branch.base, "release", "explicit base must remain authoritative")
  assert(!mock.calls.some(([url]) => new URL(url).pathname === "/repos/owner/repo"), "explicit base must not look up repository metadata")
}
{
  const aliasRequest = { ...request, runner_workspace: { ...request.runner_workspace, base: undefined, base_branch: "stable" } }
  const mock = fetchMock(false, "stable")
  const result = await publishRunnerWorkspace({ request: aliasRequest, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.branch.base, "stable", "base_branch remains a supported base alias")
  assert(!mock.calls.some(([url]) => new URL(url).pathname === "/repos/owner/repo"), "base_branch must not look up repository metadata")
}
{
  const metadataRequest = { ...request, runner_workspace: { ...request.runner_workspace, base: undefined, base_branch: undefined } }
  const mock = fetchMock(false, "trunk", "trunk")
  const result = await publishRunnerWorkspace({ request: metadataRequest, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.branch.base, "trunk", "omitted base must use the repository default branch")
  assert(mock.calls.some(([url]) => new URL(url).pathname === "/repos/owner/repo"), "omitted base must look up repository metadata")
}
for (const defaultBranch of [undefined, "invalid branch"]) {
  const metadataRequest = { ...request, runner_workspace: { ...request.runner_workspace, base: undefined, base_branch: undefined } }
  await assert.rejects(() => publishRunnerWorkspace({ request: metadataRequest, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: fetchMock(false, "main", defaultBranch).fetch }), /metadata must provide a valid default branch/)
}

{
  const mock = fetchMock(false)
  const result = await publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.pull_request.opened, true)
  assert(mock.calls.some(([, method]) => method === "POST"))
  const commitRequest = mock.calls.find(([url, method]) => new URL(url).pathname.endsWith("/git/commits") && method === "POST")
  assert.deepEqual(commitRequest?.[2]?.parents, ["base"], "new branch commits must use the base branch head as their parent")
  assert.deepEqual(result.branch, { base: "main", base_sha: "base", head: "wp-codebox/agent-task/run-1", name: "wp-codebox/agent-task/run-1" }, "first publication reports its effective branch and resolved base SHA")
}
{
  const mock = fetchMock(true)
  const result = await publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.pull_request.reused, true)
  assert(mock.calls.some(([, method]) => method === "PATCH"))
  const treeRequest = mock.calls.find(([url, method]) => new URL(url).pathname.endsWith("/git/trees") && method === "POST")
  assert.equal(treeRequest?.[2]?.base_tree, "prior-tree", "existing branch publication must extend its current tree")
  assert.deepEqual(treeRequest?.[2]?.tree, [{ path: "README.md", mode: "100644", type: "blob", sha: "blob" }], "the prior branch tree remains the base while only approved changed files are replaced")
  const commitRequest = mock.calls.find(([url, method]) => new URL(url).pathname.endsWith("/git/commits") && method === "POST")
  assert.deepEqual(commitRequest?.[2]?.parents, ["old"], "existing branch commits must use the existing branch head as their parent")
}
{
  const mock = fetchMock(true, "main", undefined, false)
  const result = await publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.branch.head, "wp-codebox/agent-task/run-1-base", "a stale post-squash branch must get a fresh base-specific publication branch")
  const treeRequest = mock.calls.find(([url, method]) => new URL(url).pathname.endsWith("/git/trees") && method === "POST")
  assert.equal(treeRequest?.[2]?.base_tree, "tree", "a fresh branch must use the current base tree, not stale branch content")
  const commitRequest = mock.calls.find(([url, method]) => new URL(url).pathname.endsWith("/git/commits") && method === "POST")
  assert.deepEqual(commitRequest?.[2]?.parents, ["base"], "a stale post-squash branch must not become the commit parent")
}
{
  const mock = fetchMock(true, "main", undefined, true, "ahead", "release")
  const result = await publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.branch.head, "wp-codebox/agent-task/run-1-base", "a PR for a different base must not be reused")
}
{
  const mock = fetchMock(true, "main", undefined, true, "diverged")
  await assert.rejects(() => publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch }), /does not descend from current base/)
  assert(!mock.calls.some(([, method]) => method === "POST" || method === "PATCH"), "an unsafe open PR branch must fail before publication writes")
}
{
  const mock = fetchMock(true, "main", undefined, false, "ahead", "main", true)
  await assert.rejects(() => publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch }), /Fresh publication branch .* already exists/)
  assert(!mock.calls.some(([, method]) => method === "POST" || method === "PATCH"), "a fresh branch collision must fail without replacing an existing ref")
}
{
  const mock = fetchMock(true, "main", undefined, false, "ahead", "main", true, true)
  const result = await publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.branch.head, "wp-codebox/agent-task/run-1-base", "an exact open PR on the fresh branch must remain the publication target")
  assert.equal(result.pull_request.reused, true, "an exact open fresh-branch PR must be reported as reused")
  assert.equal(result.pull_request.opened, false, "an exact open fresh-branch PR must not be reported as newly opened")
  const commitRequest = mock.calls.find(([url, method]) => new URL(url).pathname.endsWith("/git/commits") && method === "POST")
  assert.deepEqual(commitRequest?.[2]?.parents, ["collision"], "continued fresh-branch publication must append to its existing head")
}
await assert.rejects(() => publishRunnerWorkspace({ request: { ...request, runner_workspace: { ...request.runner_workspace, repo: "other/repo" } }, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: fetchMock().fetch }), /not authorized/)
await assert.rejects(() => publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "", fetchImpl: fetchMock().fetch }), /No GitHub token/)
await assert.rejects(() => publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: async () => response(500, {}) }), /GitHub API GET \/git\/ref\/heads\//)
{
  const mock = fetchMock(false)
  await publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles: [{ path: "README.md", mode: "100755", content: Buffer.from("changed\n").toString("base64"), deleted: false }], token: "secret", fetchImpl: mock.fetch })
  assert(mock.calls.some(([url]) => url.endsWith("/git/trees")))
}
// Branch naming (wp-codebox#2591): the caller's branch is used as given and
// a prefix is joined to the run id with a separator only when it lacks one.
assert.deepEqual(publicationHeadBranch({ branch: "docs-agent/extrachill-shop-user-docs", branch_prefix: "docs-agent/extrachill-shop-user-docs" }, { workload: { id: "docs-agent-user-maintenance" } }).head, "docs-agent/extrachill-shop-user-docs", "an explicit branch is used exactly, never with the workload id appended")
assert.equal(publicationHeadBranch({ head_branch: "release/notes" }, { workload: { id: "w" } }).head, "release/notes", "head_branch is an explicit branch alias")
assert.equal(publicationHeadBranch({ branch_prefix: "wp-codebox/agent-task/" }, { workload: { id: "run-1" } }).head, "wp-codebox/agent-task/run-1", "a prefix ending in / is joined directly")
assert.equal(publicationHeadBranch({ branch_prefix: "docs/upkeep-" }, { workload: { id: "run-1" } }).head, "docs/upkeep-run-1", "a prefix ending in - is joined directly")
assert.equal(publicationHeadBranch({ branch_prefix: "docs/upkeep" }, { workload: { id: "run-1" } }).head, "docs/upkeep-run-1", "a prefix without a trailing separator gets exactly one - separator")
assert.equal(publicationHeadBranch({}, { workload: { id: "run 1" } }).head, "wp-codebox/agent-task/run-1", "the default prefix and sanitized run id remain unchanged")
{
  const explicitRequest = { ...request, workload: { id: "docs-agent-user-maintenance", label: "Run Docs Agent" }, runner_workspace: { ...request.runner_workspace, branch: "wp-codebox/agent-task/run-1", branch_prefix: "wp-codebox/agent-task/run-1" } }
  const mock = fetchMock(false)
  const result = await publishRunnerWorkspace({ request: explicitRequest, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: mock.fetch })
  assert.equal(result.branch.head, "wp-codebox/agent-task/run-1", "first publication on an explicit branch uses it unchanged")
  const refCreate = mock.calls.find(([url, method]) => new URL(url).pathname.endsWith("/git/refs") && method === "POST")
  assert.equal(refCreate?.[2]?.ref, "refs/heads/wp-codebox/agent-task/run-1", "the created ref is the caller branch")
}
{
  const explicitRequest = { ...request, workload: { id: "docs-agent-user-maintenance", label: "Run Docs Agent" }, runner_workspace: { ...request.runner_workspace, branch: "wp-codebox/agent-task/run-1" } }
  const reused = await publishRunnerWorkspace({ request: explicitRequest, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: fetchMock(true).fetch })
  assert.equal(reused.branch.head, "wp-codebox/agent-task/run-1", "an explicit branch with an exact open PR is reused unchanged")
  assert.equal(reused.pull_request.reused, true)
  const fresh = await publishRunnerWorkspace({ request: explicitRequest, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: fetchMock(true, "main", undefined, false).fetch })
  assert.equal(fresh.branch.head, "wp-codebox/agent-task/run-1-base", "an explicit branch without an open PR gets the base-SHA suffix exactly once")
}
// Pull request title and body.
{
  const titledRequest = { ...request, runner_workspace: { ...request.runner_workspace, title: "docs(shop): user docs maintenance", body: "Summary." } }
  const mock = fetchMock(false)
  await publishRunnerWorkspace({ request: titledRequest, changedFiles: ["docs/a.md", "docs/b.md"], publicationFiles: [...publicationFiles, { path: "docs/old.md", deleted: true }], token: "secret", fetchImpl: mock.fetch })
  const pullCreate = mock.calls.find(([url, method]) => new URL(url).pathname.endsWith("/pulls") && method === "POST")
  assert.equal(pullCreate?.[2]?.title, "docs(shop): user docs maintenance", "a caller title wins over the workload label")
  assert.equal(pullCreate?.[2]?.body, "Summary.\n\n### Changed files (2)\n\n- `README.md`\n- `docs/old.md` (deleted)", "the PR body appends the changed files to the caller body")
}
assert.equal(publicationPullBody({}, []), "", "no files and no caller body yields an empty body")
assert.equal(publicationPullBody({ body: "Only body" }, []), "Only body")
console.log("runner workspace publisher ok")
