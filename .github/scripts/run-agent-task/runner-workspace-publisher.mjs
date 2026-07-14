import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

function string(value) { return typeof value === "string" ? value.trim() : "" }
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {} }

export async function publishRunnerWorkspace({ request, workspace, changedFiles, token, fetchImpl = fetch }) {
  const targetRepo = string(request.target_repo).toLowerCase()
  const config = record(request.runner_workspace)
  const configuredRepo = string(config.repo).toLowerCase()
  const allowed = Array.isArray(record(request.access).allowed_repos) ? request.access.allowed_repos.map((value) => string(value).toLowerCase()) : []
  if (!token) throw new Error("No GitHub token is available for runner workspace publication.")
  if (!targetRepo || targetRepo !== configuredRepo || !allowed.includes(targetRepo)) throw new Error("Runner workspace publication repository is not authorized.")
  const base = string(config.base || config.base_branch || "main")
  const prefix = string(config.branch_prefix || "wp-codebox/agent-task/")
  const runId = string(config.run_id || request.workload?.id || "agent-task").replace(/[^A-Za-z0-9._/-]+/g, "-")
  const head = `${prefix}${runId}`
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix) || !head.startsWith(prefix) || head.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(base)) throw new Error("Runner workspace branch configuration is invalid.")

  const api = async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${targetRepo}${path}`, { method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with ${response.status}.`)
    return payload
  }
  const baseRef = await api("GET", `/git/ref/heads/${encodeURIComponent(base)}`)
  const baseSha = string(baseRef.object?.sha)
  const baseCommit = await api("GET", `/git/commits/${baseSha}`)
  const tree = []
  for (const changed of changedFiles) {
    const relativePath = string(changed)
    if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) throw new Error("Publication changed file path is invalid.")
    const absolute = resolve(workspace, relativePath)
    if (!absolute.startsWith(`${resolve(workspace)}/`)) throw new Error("Publication changed file escapes workspace.")
    try {
      const content = await readFile(absolute)
      const blob = await api("POST", "/git/blobs", { content: content.toString("base64"), encoding: "base64" })
      tree.push({ path: relativePath, mode: "100644", type: "blob", sha: string(blob.sha) })
    } catch (error) {
      if (error?.code === "ENOENT") tree.push({ path: relativePath, mode: "100644", type: "blob", sha: null })
      else throw error
    }
  }
  const nextTree = await api("POST", "/git/trees", { base_tree: string(baseCommit.tree?.sha), tree })
  let parent = baseSha
  let existing = null
  try { existing = await api("GET", `/git/ref/heads/${head.split("/").map(encodeURIComponent).join("/")}`); parent = string(existing.object?.sha) || baseSha } catch (error) { if (!String(error.message).includes(" 404.")) throw error }
  const commit = await api("POST", "/git/commits", { message: string(config.commit_message || request.workload?.label || "Apply agent task changes"), tree: string(nextTree.sha), parents: [parent] })
  if (existing) await api("PATCH", `/git/refs/heads/${head.split("/").map(encodeURIComponent).join("/")}`, { sha: string(commit.sha), force: false })
  else await api("POST", "/git/refs", { ref: `refs/heads/${head}`, sha: string(commit.sha) })
  const pulls = await api("GET", `/pulls?state=open&head=${encodeURIComponent(`${targetRepo.split("/")[0]}:${head}`)}&base=${encodeURIComponent(base)}`)
  const pull = Array.isArray(pulls) && pulls[0] ? pulls[0] : await api("POST", "/pulls", { title: string(config.title || request.workload?.label || "Apply agent task changes"), head, base, body: string(config.body || "") })
  if (string(pull.base?.repo?.full_name).toLowerCase() !== targetRepo || string(pull.head?.ref) !== head || string(pull.base?.ref) !== base || !/^https:\/\/github\.com\//.test(string(pull.html_url))) throw new Error("GitHub publication response did not match the requested repository and branches.")
  return { schema: "wp-codebox/runner-workspace-publication-result/v1", success: true, status: "published", backend: "github-rest", branch: { base, head, name: head }, commit: { sha: string(commit.sha) }, pull_request: { number: pull.number, url: pull.html_url, reused: Boolean(Array.isArray(pulls) && pulls[0]), opened: !(Array.isArray(pulls) && pulls[0]) } }
}
