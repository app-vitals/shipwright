export type Targets = {
  adminUrl: string;
  metricsUrl: string;
  taskStoreUrl: string;
  chatUrl: string;
  mcpUrl: string;
  taskStoreToken: string;
  mcpToken: string;
};

type Env = Record<string, string | undefined>;

const URL_VARS = {
  adminUrl: "PREVIEW_ADMIN_URL",
  metricsUrl: "PREVIEW_METRICS_URL",
  taskStoreUrl: "PREVIEW_TASK_STORE_URL",
  chatUrl: "PREVIEW_CHAT_URL",
  mcpUrl: "PREVIEW_MCP_URL",
} as const;

const TOKEN_VARS = {
  taskStoreToken: "PREVIEW_TASK_STORE_TOKEN",
  mcpToken: "PREVIEW_MCP_TOKEN",
} as const;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Read the deployed-target coordinates written by `task preview:up --env-out`.
 * Throws one error naming every missing variable, and refuses any URL that is
 * not http://127.0.0.1 or http://localhost unless PREVIEW_ALLOW_REMOTE=true,
 * so the suite cannot be pointed at a real deployment by accident.
 */
export function readTargets(env: Env): Targets {
  const names = [...Object.values(URL_VARS), ...Object.values(TOKEN_VARS)];
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing preview target variables: ${missing.join(", ")}. Load them from the env file written by \`task preview:up -- --env-out <file>\`.`,
    );
  }

  if (env.PREVIEW_ALLOW_REMOTE !== "true") {
    const remote = Object.values(URL_VARS).filter(
      (name) => !isLocalUrl(env[name] as string),
    );
    if (remote.length > 0) {
      throw new Error(
        `Refusing non-local preview target URLs: ${remote.join(", ")}. Only http://127.0.0.1 and http://localhost are allowed unless PREVIEW_ALLOW_REMOTE=true.`,
      );
    }
  }

  const url = (name: string): string =>
    (env[name] as string).replace(/\/+$/, "");
  const value = (name: string): string => env[name] as string;
  return {
    adminUrl: url(URL_VARS.adminUrl),
    metricsUrl: url(URL_VARS.metricsUrl),
    taskStoreUrl: url(URL_VARS.taskStoreUrl),
    chatUrl: url(URL_VARS.chatUrl),
    mcpUrl: url(URL_VARS.mcpUrl),
    taskStoreToken: value(TOKEN_VARS.taskStoreToken),
    mcpToken: value(TOKEN_VARS.mcpToken),
  };
}
