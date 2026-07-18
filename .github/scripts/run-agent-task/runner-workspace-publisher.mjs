
function string(value) { return typeof value === "string" ? value.trim() : "" }
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {} }

export async function publishRunnerWorkspace({ request, changedFiles, publicationFiles, workspace, token, fetchImpl = fetch }) {
  const targetRepo = string(request.target_repo).toLowerCase()
  const config = record(request.runner_workspace)
  const configuredRepo = string(config.repo).toLowerCase()
  const allowed = Array.isArray(record(request.access).allowed_repos) ? request.access.allowed_repos.map((value) => string(value).toLowerCase()) : []
  if (!token) throw new Error("No GitHub token is available for runner workspace publication.")
  if (!targetRepo || targetRepo !== configuredRepo || !allowed.includes(targetRepo)) throw new Error("Runner workspace publication repository is not authorized.")
  let base = string(config.base) || string(config.base_branch)
  const hasConfiguredBase = Boolean(base)
  const prefix = string(config.branch_prefix || "wp-codebox/agent-task/")
  const runId = string(config.run_id || request.workload?.id || "agent-task").replace(/[^A-Za-z0-9._/-]+/g, "-")
  const head = `${prefix}${runId}`
  const api = async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${targetRepo}${path}`, { method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with ${response.status}.`)
    return payload
  }
  if (!base) base = string((await api("GET", "")).default_branch)
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix) || !head.startsWith(prefix) || head.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(base)) {
    throw new Error(hasConfiguredBase ? "Runner workspace branch configuration is invalid." : "Runner workspace branch configuration is invalid: repository metadata must provide a valid default branch when base is omitted.")
  }
  let existing = null
  try { existing = await api("GET", `/git/ref/heads/${head.split("/").map(encodeURIComponent).join("/")}`) } catch (error) { if (!String(error.message).includes(" 404.")) throw error }
  // Existing PR branches are append-only publication targets. Their current tree
  // is the base so files from earlier agent turns cannot disappear.
  const parent = string(existing?.object?.sha)
  const baseRef = parent ? null : await api("GET", `/git/ref/heads/${encodeURIComponent(base)}`)
  const baseSha = parent || string(baseRef.object?.sha)
  const baseCommit = await api("GET", `/git/commits/${baseSha}`)
  const tree = []
  const captured = Array.isArray(publicationFiles) ? publicationFiles : []
  if (!captured.length) throw new Error("Runner workspace publication requires immutable approved file content.")
  for (const changed of captured) {
    const relativePath = string(changed?.path)
    if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) throw new Error("Publication changed file path is invalid.")
    if (changed.deleted) { tree.push({ path: relativePath, mode: "100644", type: "blob", sha: null }); continue }
    if (changed.mode !== "100644" && changed.mode !== "100755" || typeof changed.content !== "string") throw new Error("Publication file is not an approved regular file.")
    const blob = await api("POST", "/git/blobs", { content: changed.content, encoding: "base64" })
    tree.push({ path: relativePath, mode: changed.mode, type: "blob", sha: string(blob.sha) })
  }
  const nextTree = await api("POST", "/git/trees", { base_tree: string(baseCommit.tree?.sha), tree })
  const commit = await api("POST", "/git/commits", { message: string(config.commit_message || request.workload?.label || "Apply agent task changes"), tree: string(nextTree.sha), parents: [baseSha] })
  if (existing) await api("PATCH", `/git/refs/heads/${head.split("/").map(encodeURIComponent).join("/")}`, { sha: string(commit.sha), force: false })
  else await api("POST", "/git/refs", { ref: `refs/heads/${head}`, sha: string(commit.sha) })
  const pulls = await api("GET", `/pulls?state=open&head=${encodeURIComponent(`${targetRepo.split("/")[0]}:${head}`)}&base=${encodeURIComponent(base)}`)
  const pull = Array.isArray(pulls) && pulls[0] ? pulls[0] : await api("POST", "/pulls", { title: string(config.title || request.workload?.label || "Apply agent task changes"), head, base, body: string(config.body || "") })
  if (string(pull.base?.repo?.full_name).toLowerCase() !== targetRepo || string(pull.head?.ref) !== head || string(pull.base?.ref) !== base || !/^https:\/\/github\.com\//.test(string(pull.html_url))) throw new Error("GitHub publication response did not match the requested repository and branches.")
  return { schema: "wp-codebox/runner-workspace-publication-result/v1", success: true, status: "published", backend: "github-rest", branch: { base, head, name: head }, commit: { sha: string(commit.sha) }, pull_request: { number: pull.number, url: pull.html_url, reused: Boolean(Array.isArray(pulls) && pulls[0]), opened: !(Array.isArray(pulls) && pulls[0]) } }
}
