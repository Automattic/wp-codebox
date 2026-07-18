import assert from "node:assert/strict"
import { publishRunnerWorkspace } from "../.github/scripts/run-agent-task/runner-workspace-publisher.mjs"

const request = { target_repo: "owner/repo", workload: { id: "run-1", label: "Update" }, runner_workspace: { enabled: true, repo: "owner/repo", base: "main", branch_prefix: "wp-codebox/agent-task/" }, access: { allowed_repos: ["owner/repo"] } }
const publicationFiles = [{ path: "README.md", mode: "100644", content: Buffer.from("changed\n").toString("base64"), deleted: false }]

function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body } }
function fetchMock(existing = false, base = "main", defaultBranch) {
  const calls = []
  return { calls, fetch: async (url, init) => {
    calls.push([url, init.method, init.body ? JSON.parse(init.body) : undefined])
    const parsed = new URL(url)
    const path = parsed.pathname.replace("/repos/owner/repo", "")
    if (path === "") return response(200, { default_branch: defaultBranch })
    if (path === `/git/ref/heads/${base}`) return response(200, { object: { sha: "base" } })
    if (path === "/git/commits/base" || path === "/git/commits/old") return response(200, { tree: { sha: path.endsWith("old") ? "prior-tree" : "tree" } })
    if (path.includes("/git/ref/heads/wp-codebox/agent-task/run-1")) return existing ? response(200, { object: { sha: "old" } }) : response(404, {})
    if (path === "/git/blobs") return response(201, { sha: "blob" })
    if (path === "/git/trees") return response(201, { sha: "next-tree" })
    if (path === "/git/commits") return response(201, { sha: "commit" })
    if (path === "/git/refs") return response(201, {})
    if (path.includes("/git/refs/heads/")) return response(200, {})
    if (path === "/pulls" && parsed.search) return response(200, existing ? [{ number: 4, html_url: "https://github.com/owner/repo/pull/4", base: { repo: { full_name: "owner/repo" }, ref: base }, head: { ref: "wp-codebox/agent-task/run-1" } }] : [])
    if (path === "/pulls") return response(201, { number: 5, html_url: "https://github.com/owner/repo/pull/5", base: { repo: { full_name: "owner/repo" }, ref: base }, head: { ref: "wp-codebox/agent-task/run-1" } })
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
await assert.rejects(() => publishRunnerWorkspace({ request: { ...request, runner_workspace: { ...request.runner_workspace, repo: "other/repo" } }, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: fetchMock().fetch }), /not authorized/)
await assert.rejects(() => publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "", fetchImpl: fetchMock().fetch }), /No GitHub token/)
await assert.rejects(() => publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles, token: "secret", fetchImpl: async () => response(500, {}) }), /GitHub API GET \/git\/ref\/heads\//)
{
  const mock = fetchMock(false)
  await publishRunnerWorkspace({ request, changedFiles: ["README.md"], publicationFiles: [{ path: "README.md", mode: "100755", content: Buffer.from("changed\n").toString("base64"), deleted: false }], token: "secret", fetchImpl: mock.fetch })
  assert(mock.calls.some(([url]) => url.endsWith("/git/trees")))
}
console.log("runner workspace publisher ok")
