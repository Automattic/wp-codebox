export function isCacheablePublicationResponse(response: Response): boolean {
  if (response.headers.has("set-cookie")) return false
  if (response.status === 200) return response.headers.get("content-type")?.includes("text/html") ?? false
  return (response.status === 301 || response.status === 308) && response.headers.has("location")
}
