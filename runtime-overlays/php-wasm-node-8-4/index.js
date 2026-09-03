// packages/php-wasm/node-builds/8-4/src/index.ts
import { jspi } from "wasm-feature-detect";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
var currentDirPath = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
var packageDir = existsSync(join(currentDirPath, "jspi")) ? currentDirPath : dirname(currentDirPath);
async function getPHPLoaderModule() {
  if (await jspi()) {
    return await import("./jspi/php_8_4.js");
  } else {
    return await import("./asyncify/php_8_4.js");
  }
}
async function getIntlExtensionPath() {
  if (await jspi()) {
    return join(packageDir, "jspi/extensions/intl/intl.so");
  } else {
    return join(packageDir, "asyncify/extensions/intl/intl.so");
  }
}
async function getXdebugExtensionPath() {
  if (await jspi()) {
    return join(packageDir, "jspi/extensions/xdebug/xdebug.so");
  } else {
    return join(packageDir, "asyncify/extensions/xdebug/xdebug.so");
  }
}
async function getRedisExtensionPath() {
  if (await jspi()) {
    return join(packageDir, "jspi/extensions/redis/redis.so");
  }
  throw new Error(
    "The Redis extension requires JSPI (JavaScript Promise Integration) support. Your current environment is using asyncify, which cannot properly handle exceptions during Redis network operations. Please use Node.js 23+ or a browser with JSPI support to use the Redis extension."
  );
}
async function getMemcachedExtensionPath() {
  if (await jspi()) {
    return join(packageDir, "jspi/extensions/memcached/memcached.so");
  }
  throw new Error(
    "The Memcached extension requires JSPI (JavaScript Promise Integration) support. Your current environment is using asyncify, which cannot properly handle exceptions during Memcached network operations. Please use Node.js 23+ or a browser with JSPI support to use the Memcached extension."
  );
}
export {
  getIntlExtensionPath,
  getMemcachedExtensionPath,
  getPHPLoaderModule,
  getRedisExtensionPath,
  getXdebugExtensionPath,
  jspi
};
