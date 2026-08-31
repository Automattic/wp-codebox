import { register } from "node:module"

register("./package-local-loader.mjs", import.meta.url)
