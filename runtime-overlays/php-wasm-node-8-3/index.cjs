var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/php-wasm/node-builds/8-3/src/index.ts
var src_exports = {};
__export(src_exports, {
  getIntlExtensionPath: () => getIntlExtensionPath,
  getMemcachedExtensionPath: () => getMemcachedExtensionPath,
  getPHPLoaderModule: () => getPHPLoaderModule,
  getRedisExtensionPath: () => getRedisExtensionPath,
  getXdebugExtensionPath: () => getXdebugExtensionPath,
  jspi: () => import_wasm_feature_detect.jspi
});
module.exports = __toCommonJS(src_exports);
var import_wasm_feature_detect = require("wasm-feature-detect");
var import_node_url = require("node:url");
var import_node_path = require("node:path");
var import_node_fs = require("node:fs");
var import_meta = {};
var currentDirPath = typeof __dirname !== "undefined" ? __dirname : (0, import_node_path.dirname)((0, import_node_url.fileURLToPath)(import_meta.url));
var packageDir = (0, import_node_fs.existsSync)((0, import_node_path.join)(currentDirPath, "jspi")) ? currentDirPath : (0, import_node_path.dirname)(currentDirPath);
async function getPHPLoaderModule() {
  if (await (0, import_wasm_feature_detect.jspi)()) {
    return await import("./jspi/php_8_3.js");
  } else {
    return await import("./asyncify/php_8_3.js");
  }
}
async function getIntlExtensionPath() {
  if (await (0, import_wasm_feature_detect.jspi)()) {
    return (0, import_node_path.join)(packageDir, "jspi/extensions/intl/intl.so");
  } else {
    return (0, import_node_path.join)(packageDir, "asyncify/extensions/intl/intl.so");
  }
}
async function getXdebugExtensionPath() {
  if (await (0, import_wasm_feature_detect.jspi)()) {
    return (0, import_node_path.join)(packageDir, "jspi/extensions/xdebug/xdebug.so");
  } else {
    return (0, import_node_path.join)(packageDir, "asyncify/extensions/xdebug/xdebug.so");
  }
}
async function getRedisExtensionPath() {
  if (await (0, import_wasm_feature_detect.jspi)()) {
    return (0, import_node_path.join)(packageDir, "jspi/extensions/redis/redis.so");
  }
  throw new Error(
    "The Redis extension requires JSPI (JavaScript Promise Integration) support. Your current environment is using asyncify, which cannot properly handle exceptions during Redis network operations. Please use Node.js 23+ or a browser with JSPI support to use the Redis extension."
  );
}
async function getMemcachedExtensionPath() {
  if (await (0, import_wasm_feature_detect.jspi)()) {
    return (0, import_node_path.join)(packageDir, "jspi/extensions/memcached/memcached.so");
  }
  throw new Error(
    "The Memcached extension requires JSPI (JavaScript Promise Integration) support. Your current environment is using asyncify, which cannot properly handle exceptions during Memcached network operations. Please use Node.js 23+ or a browser with JSPI support to use the Memcached extension."
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getIntlExtensionPath,
  getMemcachedExtensionPath,
  getPHPLoaderModule,
  getRedisExtensionPath,
  getXdebugExtensionPath,
  jspi
});
