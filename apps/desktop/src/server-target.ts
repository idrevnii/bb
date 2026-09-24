import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const SERVER_TARGET_FILE_NAME = "server-target.json";
export const BUILTIN_SERVER_NAME = "This Mac";
export const MAX_SERVER_NAME_LENGTH = 64;

export interface ConnectServerRef {
  handle: string;
  name: string;
  url: string;
}

export interface CustomServer {
  name: string | null;
  url: string;
}

interface SetCustomServerUrlOptions {
  name?: string | null;
  replacedUrl?: string;
}

export type DesktopServerTarget =
  | { kind: "builtin" }
  | { kind: "connect"; server: ConnectServerRef }
  | { kind: "custom"; url: string };

export interface ServerTargetFs {
  mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

interface CreateServerTargetStoreArgs {
  fs?: ServerTargetFs;
  storagePath: string;
}

export interface ServerTargetStore {
  getConnectServer(): ConnectServerRef | null;
  getCustomServerUrl(): string | null;
  getCustomServers(): CustomServer[];
  getShowBuiltinServer(): boolean;
  getTarget(): DesktopServerTarget;
  load(): Promise<void>;
  refreshConnectServer(server: ConnectServerRef): Promise<boolean>;
  setConnectServer(server: ConnectServerRef): Promise<void>;
  setCustomServerUrl(
    url: string | null,
    options?: SetCustomServerUrlOptions,
  ): Promise<void>;
  setShowBuiltinServer(show: boolean): Promise<void>;
  setTarget(kind: "builtin" | "connect" | "custom"): Promise<boolean>;
}

const persistedConnectServerSchema = z
  .object({
    handle: z.string().min(1),
    name: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();

const persistedServerTargetSchema = z
  .object({
    connectServer: persistedConnectServerSchema.nullable().optional(),
    customServerNames: z.record(z.string(), z.string().min(1)).default({}),
    customServerUrl: z.string().min(1).nullable(),
    customServerUrls: z.array(z.string().min(1)).default([]),
    showBuiltinServer: z.boolean().default(true),
    target: z.enum(["builtin", "connect", "custom"]),
  })
  .strict();

type PersistedServerTarget = z.infer<typeof persistedServerTargetSchema>;

const defaultFs: ServerTargetFs = {
  mkdir,
  readFile,
  writeFile,
};

export function normalizeCustomServerUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

export function normalizeServerName(rawName: string): string | null {
  const trimmed = rawName.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_SERVER_NAME_LENGTH) {
    throw new Error(
      `Server names can be at most ${MAX_SERVER_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function parsePersistedServerTarget(raw: string): PersistedServerTarget | null {
  try {
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = persistedServerTargetSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createServerTargetStore(
  args: CreateServerTargetStoreArgs,
): ServerTargetStore {
  const fsImpl = args.fs ?? defaultFs;
  let connectServer: ConnectServerRef | null = null;
  let customServerUrl: string | null = null;
  let customServerUrls: string[] = [];
  let customServerNames = new Map<string, string>();
  let showBuiltinServer = true;
  let target: "builtin" | "connect" | "custom" = "builtin";

  async function persist(): Promise<void> {
    await fsImpl.mkdir(dirname(args.storagePath), { recursive: true });
    const payload: PersistedServerTarget = {
      connectServer,
      customServerNames: Object.fromEntries(
        customServerUrls.flatMap((url) => {
          const name = customServerNames.get(url);
          return name === undefined ? [] : [[url, name]];
        }),
      ),
      customServerUrl,
      customServerUrls,
      showBuiltinServer,
      target,
    };
    await fsImpl.writeFile(
      args.storagePath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    getConnectServer() {
      return connectServer === null ? null : { ...connectServer };
    },
    getCustomServerUrl() {
      return customServerUrl;
    },
    getCustomServers() {
      return customServerUrls.map((url) => ({
        name: customServerNames.get(url) ?? null,
        url,
      }));
    },
    getShowBuiltinServer() {
      return showBuiltinServer;
    },
    getTarget() {
      if (target === "custom" && customServerUrl !== null) {
        return { kind: "custom", url: customServerUrl };
      }
      if (target === "connect" && connectServer !== null) {
        return { kind: "connect", server: { ...connectServer } };
      }
      return { kind: "builtin" };
    },
    async load() {
      let persisted: PersistedServerTarget | null = null;
      try {
        persisted = parsePersistedServerTarget(
          await fsImpl.readFile(args.storagePath, "utf8"),
        );
      } catch {
        persisted = null;
      }
      if (persisted === null) {
        connectServer = null;
        customServerUrl = null;
        customServerUrls = [];
        customServerNames = new Map();
        showBuiltinServer = true;
        target = "builtin";
        return;
      }
      connectServer = persisted.connectServer ?? null;
      customServerUrl =
        persisted.customServerUrl === null
          ? null
          : normalizeCustomServerUrl(persisted.customServerUrl);
      customServerUrls = [
        ...new Set(
          [
            ...persisted.customServerUrls,
            ...(customServerUrl === null ? [] : [customServerUrl]),
          ]
            .map(normalizeCustomServerUrl)
            .filter((url): url is string => url !== null),
        ),
      ];
      customServerNames = new Map(
        Object.entries(persisted.customServerNames).flatMap(
          ([rawUrl, rawName]): Array<[string, string]> => {
            const url = normalizeCustomServerUrl(rawUrl);
            const name = rawName.trim().slice(0, MAX_SERVER_NAME_LENGTH);
            return url === null ||
              name.length === 0 ||
              !customServerUrls.includes(url)
              ? []
              : [[url, name]];
          },
        ),
      );
      showBuiltinServer = persisted.showBuiltinServer;
      if (persisted.target === "custom" && customServerUrl !== null) {
        target = "custom";
      } else if (persisted.target === "connect" && connectServer !== null) {
        target = "connect";
      } else {
        target = "builtin";
      }
    },
    async refreshConnectServer(server) {
      if (
        connectServer === null ||
        connectServer.handle !== server.handle ||
        (connectServer.name === server.name && connectServer.url === server.url)
      ) {
        return false;
      }
      connectServer = { ...server };
      await persist();
      return true;
    },
    async setConnectServer(server) {
      connectServer = { ...server };
      target = "connect";
      await persist();
    },
    async setCustomServerUrl(url, options = {}) {
      const normalized = url === null ? null : normalizeCustomServerUrl(url);
      if (url !== null && normalized === null) {
        throw new Error("Enter a valid http(s) URL.");
      }
      const name =
        options.name === undefined || options.name === null
          ? options.name
          : normalizeServerName(options.name);
      const removedUrl =
        options.replacedUrl ?? (url === null ? customServerUrl : null);
      const removedIndex =
        removedUrl === null ? -1 : customServerUrls.indexOf(removedUrl);
      const carriedName =
        removedUrl === null ? undefined : customServerNames.get(removedUrl);
      customServerUrls = customServerUrls.filter(
        (saved) => saved !== removedUrl,
      );
      if (removedUrl !== null) {
        customServerNames.delete(removedUrl);
      }
      if (normalized === null) {
        customServerUrl = customServerUrls[0] ?? null;
        if (target === "custom") {
          target = "builtin";
        }
      } else {
        customServerUrl = normalized;
        if (!customServerUrls.includes(normalized)) {
          customServerUrls.splice(
            removedIndex === -1 ? customServerUrls.length : removedIndex,
            0,
            normalized,
          );
        }
        const nextName = name === undefined ? carriedName : name;
        if (nextName === null) {
          customServerNames.delete(normalized);
        } else if (nextName !== undefined) {
          customServerNames.set(normalized, nextName);
        }
        target = "custom";
      }
      await persist();
    },
    async setShowBuiltinServer(show) {
      showBuiltinServer = show;
      await persist();
    },
    async setTarget(kind) {
      if (kind === "custom" && customServerUrl === null) {
        return false;
      }
      if (kind === "connect" && connectServer === null) {
        return false;
      }
      if (target === kind) {
        return true;
      }
      target = kind;
      await persist();
      return true;
    },
  };
}
