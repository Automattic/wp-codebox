export function normalizeReleasePlatform(platformName: NodeJS.Platform): string {
  if (platformName === "darwin") return "macos"
  if (platformName === "win32") return "windows"
  return platformName
}

export function releaseTargetMatchesHost(target: string, hostPlatform: NodeJS.Platform, hostArch: string): boolean {
  return target === `${normalizeReleasePlatform(hostPlatform)}-${hostArch}`
}
