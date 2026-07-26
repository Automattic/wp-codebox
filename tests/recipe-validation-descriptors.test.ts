import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { recipePolicy, validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import type { WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-recipe-validation-descriptors-", async (recipeDirectory) => {
  const recipePath = join(recipeDirectory, "recipe.json")
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: {
      steps: [
        { command: "wordpress.browser-probe", args: ["capture=console,bogus", "duration=forever", "profile=desktop-webkit"] },
        { command: "wordpress.browser-actions", args: ["capture=steps,bogus", "timeout=forever"] },
        { command: "wordpress.browser-scenario", args: ["capture=performance,bogus", "step-timeout=forever"] },
        { command: "wordpress.editor-actions", args: ["capture=steps,bogus", "wait-timeout=forever"] },
      ],
    },
  }

  const issues = await validateWorkspaceRecipeSemantics(recipe, recipePath)
  assert.deepEqual(issues.filter((issue) => issue.path === "$.workflow.steps[0].args"), [
    { code: "missing-url", path: "$.workflow.steps[0].args", message: "wordpress.browser-probe requires url=<path-or-url>." },
    { code: "invalid-duration", path: "$.workflow.steps[0].args", message: "wordpress.browser-probe duration must look like 500ms or 2s." },
    { code: "invalid-profile", path: "$.workflow.steps[0].args", message: "wordpress.browser-probe profile is unsupported: desktop-webkit" },
    { code: "invalid-capture", path: "$.workflow.steps[0].args", message: "wordpress.browser-probe capture does not support: bogus" },
  ])
  assert.deepEqual(issues.filter((issue) => issue.path === "$.workflow.steps[1].args"), [
    { code: "missing-steps", path: "$.workflow.steps[1].args", message: "wordpress.browser-actions requires steps-json=<array>, url=<path-or-url>, or adaptive-exploration-json=<object>." },
    { code: "invalid-duration", path: "$.workflow.steps[1].args", message: "wordpress.browser-actions timeout must look like 500ms or 2s." },
    { code: "invalid-capture", path: "$.workflow.steps[1].args", message: "wordpress.browser-actions capture does not support: bogus" },
  ])
  assert.deepEqual(issues.filter((issue) => issue.path === "$.workflow.steps[2].args"), [
    { code: "missing-scenario", path: "$.workflow.steps[2].args", message: "wordpress.browser-scenario requires scenario-json=<object> or url=<path-or-url>." },
    { code: "invalid-duration", path: "$.workflow.steps[2].args", message: "wordpress.browser-scenario step-timeout must look like 500ms or 2s." },
    { code: "invalid-capture", path: "$.workflow.steps[2].args", message: "wordpress.browser-scenario capture does not support: bogus" },
  ])
  assert.deepEqual(issues.filter((issue) => issue.path === "$.workflow.steps[3].args"), [
    { code: "missing-steps", path: "$.workflow.steps[3].args", message: "wordpress.editor-actions requires steps-json=<array>." },
    { code: "invalid-duration", path: "$.workflow.steps[3].args", message: "wordpress.editor-actions wait-timeout must look like 500ms or 2s." },
    { code: "invalid-capture", path: "$.workflow.steps[3].args", message: "wordpress.editor-actions capture does not support: bogus" },
  ])
})

await withTempDir("wp-codebox-recipe-geolocation-validation-", async (recipeDirectory) => {
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [
      { command: "wordpress.browser-probe", args: ["url=/", "geolocation-latitude=NaN", "geolocation-longitude=181", "geolocation-accuracy=-1", "geolocation-permission=maybe"] },
      { command: "wordpress.browser-probe", args: ["url=/", "geolocation-latitude=32.7765", "geolocation-permission=granted"] },
      { command: "wordpress.browser-probe", args: ["url=/", "geolocation-latitude=32.7765", "geolocation-longitude=-79.9311", "geolocation-accuracy=8", "geolocation-permission=default"] },
      { command: "wordpress.browser-actions", args: ["url=/", "geolocation-latitude=32.7765", "geolocation-permission=granted", "is-mobile=maybe", "has-touch=true"] },
      { command: "wordpress.browser-scenario", args: ["url=/", "browser-environment-json={\"isMobile\":\"yes\"}"] },
      { command: "wordpress.browser-actions", args: ["url=/", "browser-environment-json={}", "steps-json={"] },
      { command: "wordpress.browser-scenario", args: ["url=/", "browser-environment-json={}", "steps-json={"] },
      { command: "wordpress.browser-scenario", args: [`scenario-json=${JSON.stringify({ url: "/", profile: "unknown-mobile" })}`] },
    ] },
  }
  const issues = await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json"))
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[0].args").map(({ code }) => code), ["invalid-geolocation-latitude", "invalid-geolocation-longitude", "invalid-geolocation-accuracy", "invalid-geolocation-permission"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[1].args").map(({ code }) => code), ["incomplete-geolocation", "incomplete-geolocation"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[2].args"), [])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[3].args").map(({ code }) => code), ["invalid-is-mobile", "incomplete-geolocation", "incomplete-geolocation"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[4].args").map(({ code }) => code), ["invalid-browser-environment"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[5].args").map(({ code }) => code), ["invalid-steps-json"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[6].args").map(({ code }) => code), ["invalid-steps-json"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[7].args").map(({ code }) => code), ["invalid-profile"])
})

await withTempDir("wp-codebox-recipe-browser-environment-file-", async (recipeDirectory) => {
  await writeFile(join(recipeDirectory, "valid-environment.json"), JSON.stringify({ isMobile: true, hasTouch: true }))
  await writeFile(join(recipeDirectory, "invalid-environment.json"), "{")
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [
      { command: "wordpress.browser-actions", args: ["url=/", "browser-environment-json=@valid-environment.json"] },
      { command: "wordpress.browser-actions", args: ["url=/", "browser-environment-json=@invalid-environment.json"] },
      { command: "wordpress.browser-scenario", args: ["url=/", "browser-environment-json=@missing-environment.json"] },
    ] },
  }
  const issues = await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json"))
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[0].args"), [])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[1].args").map(({ code }) => code), ["invalid-browser-environment"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[2].args").map(({ code }) => code), ["invalid-browser-environment"])
})

await withTempDir("wp-codebox-recipe-browser-payload-files-", async (recipeDirectory) => {
  await writeFile(join(recipeDirectory, "action-steps.json"), JSON.stringify([{ kind: "evaluate", expression: "document.title" }]))
  await writeFile(join(recipeDirectory, "scenario.json"), JSON.stringify({ url: "/", steps: [{ kind: "evaluate", expression: "location.href" }] }))
  await writeFile(join(recipeDirectory, "scenario-steps.json"), JSON.stringify([{ kind: "evaluate", expression: "document.body.dataset.ready" }]))
  await writeFile(join(recipeDirectory, "malformed.json"), "{")
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    workflow: { steps: [
      { command: "wordpress.browser-actions", args: ["url=/", "steps-json=@action-steps.json"] },
      { command: "wordpress.browser-scenario", args: ["scenario-json=@scenario.json"] },
      { command: "wordpress.browser-scenario", args: ["url=/", "steps-json=@scenario-steps.json"] },
      { command: "wordpress.browser-actions", args: ["url=/", "steps-json=@malformed.json"] },
      { command: "wordpress.browser-scenario", args: ["scenario-json=@malformed.json"] },
      { command: "wordpress.browser-scenario", args: ["url=/", "steps-json=@missing.json"] },
    ] },
  }
  const issues = await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json"))
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[0].args"), [])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[1].args"), [])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[2].args"), [])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[3].args").map(({ code }) => code), ["invalid-steps-json"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[4].args").map(({ code }) => code), ["invalid-scenario-json"])
  assert.deepEqual(issues.filter(({ path }) => path === "$.workflow.steps[5].args").map(({ code }) => code), ["invalid-steps-json"])
  assert.equal(recipePolicy(recipe, recipeDirectory).commands.includes("wordpress.browser-actions.evaluate"), true)
  for (const step of recipe.workflow.steps.slice(0, 3)) {
    assert.equal(recipePolicy({ schema: recipe.schema, workflow: { steps: [step] } }, recipeDirectory).commands.includes("wordpress.browser-actions.evaluate"), true)
  }
})

console.log("recipe validation descriptors ok")
