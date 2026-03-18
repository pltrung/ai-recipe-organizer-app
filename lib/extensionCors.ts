/** CORS for Chrome extension calling APIs from chrome-extension:// origin */
export const EXTENSION_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function withExtensionCors(
  init?: ResponseInit
): ResponseInit {
  return {
    ...init,
    headers: {
      ...EXTENSION_CORS_HEADERS,
      ...(init?.headers as Record<string, string>),
    },
  };
}
