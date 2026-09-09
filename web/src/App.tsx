import type { ChangeEvent, FormEvent, SyntheticEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import GraphView, { type GraphExportHandle } from "./GraphView";
import DocPanel from "./components/DocPanel";
import OverviewGrid from "./components/OverviewGrid";
import UnderTheHoodPanel from "./components/UnderTheHoodPanel";
import type { QuantityFormData } from "./components/quantityShared";
import CollapsibleSection from "./components/CollapsibleSection";
import { useSelection } from "./store/selection";
import { jsPDF } from "jspdf";
import type { AuditTrailEntry, QuantityNode, UmlClassNode, UmlGraphState } from "./types/uml";
import {
  ensureDiffResponse,
  ensureGraphResponse,
  type ApiEdge,
  type ApiGraph,
  type ApiNode,
  type DiffResponse
} from "./types/api";
import type { WorkspaceState } from "./types/workspace";
import { API_FEATURE_HEADER, API_VERSION, API_VERSION_HEADER, DEFAULT_FEATURE_FLAGS } from "./constants/api";
import { DEFAULT_API, DEFAULT_BRANCH, DEFAULT_NAMESPACE, DEFAULT_ROOT, DEFAULT_PACKAGE, LIGHT_MODE } from "./constants/defaults";
import { useWorkspaceStore } from "./store/workspace";
import { fqidFromParts, normalizeId, normalizeLabel, normalizeModule } from "./utils/identifier";
import { formatApiError } from "./utils/errors";
import { buildUmlStateFromGraph } from "./utils/umlState";

type WorkspaceEnvelope = { workspace?: WorkspaceState };

type TaskStatusResponse = {
  task_id: string;
  status: string;
  ready: boolean;
  result?: unknown;
  error?: string;
  workspace?: WorkspaceState;
};

type GraphRequestParams = {
  root?: string;
  include_quantities?: boolean;
  include_subsections?: boolean;
  include_inheritance?: boolean;
  allow_cross_module?: boolean;
  base_namespace?: string;
};

type GraphTaskBody = {
  branch: string;
  package: string;
};

type ExportFilter = {
  name: string;
  extensions: string[];
};

type TaskEnqueueResponse = WorkspaceEnvelope & {
  result?: unknown;
  task_id?: string;
};

const triggerBrowserDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export default function App() {
  const apiBase = DEFAULT_API;
  const [runtimeLightMode, setRuntimeLightMode] = useState<boolean>(LIGHT_MODE);
  const isLightMode = runtimeLightMode;
  const [token, setToken] = useState<string>(() => {
    if (runtimeLightMode) return "light";
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("schema-uml-token") || "";
  });
  const [userName, setUserName] = useState<string | null>(() => {
    if (runtimeLightMode) return "local";
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("schema-uml-username");
  });
  const [sessionChecked, setSessionChecked] = useState<boolean>(runtimeLightMode);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(() =>
    runtimeLightMode
      ? { branch: DEFAULT_BRANCH, package: DEFAULT_PACKAGE, base_namespace: DEFAULT_NAMESPACE }
      : null
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [loginUsername, setLoginUsername] = useState<string>("admin");
  const [loginPassword, setLoginPassword] = useState<string>("admin");
  const {
    branch: workspaceBranch,
    pkg,
    baseNamespace: namespace,
    startEmpty,
    setBranch: setWorkspaceBranch,
    setPkg,
    setStartEmpty,
    applyWorkspace: applyWorkspaceInStore,
  } = useWorkspaceStore();
  const [availablePkgs, setAvailablePkgs] = useState<string[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState<string>(DEFAULT_ROOT);

  const [includeQuantities, setIncludeQuantities] = useState<boolean>(true);
  const [includeSubsections, setIncludeSubsections] = useState<boolean>(true);
  const [includeInheritance, setIncludeInheritance] = useState<boolean>(true);
  const [showBaseSections, setShowBaseSections] = useState<boolean>(false);
  const [showQuantityMetadata, setShowQuantityMetadata] = useState<boolean>(false);

  const [crossModules, setCrossModules] = useState<boolean>(true);

  const [graph, setGraph] = useState<ApiGraph | null>(null);
  const [baseGraph, setBaseGraph] = useState<ApiGraph | null>(null);
  const [umlState, setUmlState] = useState<UmlGraphState | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedQuantityId, setSelectedQuantityId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  // appearance
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const stored = window.localStorage.getItem("schema-uml-theme");
    const initial = stored === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", initial);
    return initial;
  });

  const appShellRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const workspaceStateRef = useRef<WorkspaceState | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 360;
    const stored = Number.parseInt(window.localStorage.getItem("schema-uml-left-width") || "", 10);
    return Number.isFinite(stored) ? stored : 360;
  });
  const [docPanelWidth, setDocPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 380;
    const stored = Number.parseInt(window.localStorage.getItem("schema-uml-doc-width") || "", 10);
    return Number.isFinite(stored) ? stored : 380;
  });
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [canvasStatus, setCanvasStatus] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<string>("");
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sending, setSending] = useState<boolean>(false);
  const [sendDesignEnabled, setSendDesignEnabled] = useState<boolean>(false);
  const [schemaVersion, setSchemaVersion] = useState<string | null>(null);
  const [schemaSource, setSchemaSource] = useState<string | null>(null);
  const [schemaUpdateStatus, setSchemaUpdateStatus] = useState<string | null>(null);
  const [schemaUpdating, setSchemaUpdating] = useState<boolean>(false);
  const canUpdateSchema = isLightMode && schemaSource !== "bundled";

  // branch diff state
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState<string>(workspaceBranch || "");
  const [headBranch, setHeadBranch] = useState<string>(workspaceBranch || "");
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);

  // collapsible controls for accessibility / quick-open links
  const [openWorkspace, setOpenWorkspace] = useState<boolean>(false);
  const [openUnderTheHood, setOpenUnderTheHood] = useState<boolean>(false);
  const [openCompare, setOpenCompare] = useState<boolean>(false);
  const [openDocumentation, setOpenDocumentation] = useState<boolean>(true);
  const [openAuditTrail, setOpenAuditTrail] = useState<boolean>(true);

  const isAuditChange = (value: unknown): value is AuditTrailEntry["change"] => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.type === "string";
  };

  const parseAuditEntry = (value: unknown): AuditTrailEntry | null => {
    if (!value || typeof value !== "object") return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.timestamp !== "string" || typeof entry.description !== "string") {
      return null;
    }
    if (!isAuditChange(entry.change)) return null;
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      description: entry.description,
      change: entry.change,
      replayable: entry.replayable === false ? false : true,
      package: typeof entry.package === "string" ? entry.package : undefined,
    };
  };

  const [auditTrail, setAuditTrail] = useState<AuditTrailEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem("schema-uml-audit");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(parseAuditEntry)
        .filter((e): e is AuditTrailEntry => Boolean(e))
        .filter((e) => !(typeof e.id === "string" && e.id.startsWith("persisted-")));
    } catch {
      return [];
    }
  });

  // editable mode
  const [editableMode, setEditableMode] = useState<boolean>(false);
  const [quantityActionErr, setQuantityActionErr] = useState<string | null>(null);
  const [creatingQuantityFor, setCreatingQuantityFor] = useState<string | null>(null);
  const [creatingClass, setCreatingClass] = useState<boolean>(false);

  const [graphHandle, setGraphHandle] = useState<GraphExportHandle | null>(null);

  const { selected, setSelected } = useSelection();

  const clearQuantityActionError = useCallback(() => setQuantityActionErr(null), []);

  useEffect(() => {
    if (!selected) {
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      return;
    }
    if (selected.kind === "class") {
      setSelectedClassId(selected.id);
      setSelectedQuantityId(null);
      return;
    }
    if (selected.kind === "quantity" && selected.owner) {
      setSelectedClassId(selected.owner);
      setSelectedQuantityId(selected.id);
    }
  }, [selected]);

  // overview mode
  const [mode, setMode] = useState<"graph" | "overview">("graph");
  const [overviewBranch, setOverviewBranch] = useState<string>(workspaceBranch || DEFAULT_BRANCH);
  const [packageBranch, setPackageBranch] = useState<string>(workspaceBranch || DEFAULT_BRANCH);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("schema-uml-audit", JSON.stringify(auditTrail));
    } catch {
      // ignore storage errors
    }
  }, [auditTrail]);

  const api = useMemo(() => {
    const instance = axios.create({ baseURL: apiBase });
    instance.interceptors.request.use((config) => {
      config.headers = config.headers ?? {};
      config.headers[API_VERSION_HEADER] = API_VERSION;
      config.headers[API_FEATURE_HEADER] = DEFAULT_FEATURE_FLAGS.join(",");
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });
    return instance;
  }, [apiBase, token]);
  const normalizedNamespace = useMemo(() => {
    const parts = namespace.split(",").map((p: string) => p.trim()).filter(Boolean);
    return parts.length > 0 ? parts.join(",") : DEFAULT_NAMESPACE;
  }, [namespace]);
  const namespaceFilters = useMemo(
    () => normalizedNamespace.split(",").map((p: string) => p.trim()).filter(Boolean),
    [normalizedNamespace]
  );
  const pinnedClassIds = useMemo(
    () =>
      auditTrail
        .filter((entry) => entry.replayable !== false && entry.change?.type === "add-class")
        .map((entry) => (entry.change.type === "add-class" ? entry.change.cls.id : ""))
        .filter(Boolean),
    [auditTrail]
  );

  const basePackageForEmpty = useMemo(() => {
    const parts = normalizedNamespace.split(",").map((p: string) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      return parts[0];
    }
    // fall back to stripping the last segment of the default package
    const segments = pkg.split(".");
    return segments.slice(0, Math.max(1, segments.length - 1)).join(".");
  }, [normalizedNamespace, pkg]);

  const scratchPackage = useMemo(
    () => `${basePackageForEmpty}.custom_schema`,
    [basePackageForEmpty]
  );

  const emptyCanvasActive = startEmpty && graph?.package === scratchPackage && graph?.root === "";

  const preferTaskApi = useMemo(() => {
    if (isLightMode) return false;
    const raw = import.meta.env.VITE_USE_TASK_API;
    if (typeof raw === "string" && raw.toLowerCase() === "false") return false;
    return true;
  }, [isLightMode]);

  const taskPollInterval = useMemo(() => {
    const raw = Number.parseInt(import.meta.env.VITE_TASK_POLL_MS ?? "1000", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 1000;
  }, []);

  const taskPollTimeout = useMemo(() => {
    const raw = Number.parseInt(import.meta.env.VITE_TASK_POLL_TIMEOUT_MS ?? "180000", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 180000;
  }, []);

  const applyWorkspace = useCallback((ws: WorkspaceState | null) => {
    if (!ws) return;
    const prev = workspaceStateRef.current;
    const unchanged =
      prev &&
      prev.branch === ws.branch &&
      prev.package === ws.package &&
      prev.base_namespace === ws.base_namespace;
    if (unchanged) return;

    workspaceStateRef.current = ws;
    setWorkspace(ws);
    applyWorkspaceInStore(ws);
    if (ws.branch) {
      setPackageBranch(ws.branch);
      setOverviewBranch(ws.branch);
      setBaseBranch((prev) => prev || ws.branch);
      setHeadBranch((prev) => prev || ws.branch);
    }
  }, [applyWorkspaceInStore]);

  const syncWorkspaceFromResponse = useCallback(
    (payload: WorkspaceEnvelope | null | undefined) => {
      if (payload?.workspace) applyWorkspace(payload.workspace);
    },
    [applyWorkspace]
  );

  const updateWorkspaceOnServer = useCallback(
    async (updates: Partial<WorkspaceState>) => {
      if (!token) return;
      try {
        const res = await api.put("/workspace", updates);
        applyWorkspace(res.data.workspace as WorkspaceState);
      } catch (error: unknown) {
        console.error("Failed to update workspace", error);
      }
    },
    [api, applyWorkspace, token]
  );

  const pollTaskStatus = useCallback(
    async (taskId: string): Promise<TaskStatusResponse> => {
      const started = Date.now();
      let delay = taskPollInterval;
      while (true) {
        const res = await api.get<TaskStatusResponse>(`/tasks/${taskId}`);
        if (res.data?.workspace) syncWorkspaceFromResponse(res.data);
        if (res.data.status === "SUCCESS") return res.data;
        if (res.data.status === "REVOKED" || res.data.status === "RETRY") {
          const msg = res.data.error || `Task ${res.data.status.toLowerCase()}`;
          throw new Error(msg);
        }
        if (res.data.ready && res.data.status !== "SUCCESS") {
          const msg = res.data.error || `Task ${res.data.status.toLowerCase()}`;
          throw new Error(msg);
        }
        if (res.data.status === "FAILURE") {
          const msg = res.data.error || "Task failed";
          throw new Error(msg);
        }
        if (Date.now() - started > taskPollTimeout) {
          throw new Error("Timed out waiting for background task");
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(Math.round(delay * 1.3), 4000);
      }
    },
    [api, syncWorkspaceFromResponse, taskPollInterval, taskPollTimeout]
  );

  const taskUnavailable = (err: unknown) => {
    if (axios.isAxiosError(err) && err.response) {
      const code = err.response.status;
      return code === 404 || code === 405 || code === 501;
    }
    return false;
  };

  const enqueueGraphTask = useCallback(
    async (body: GraphTaskBody, params: GraphRequestParams): Promise<unknown | null> => {
      if (!preferTaskApi) return null;
      try {
        setCanvasStatus((prev) => prev ?? "Queued background job…");
        const res = await api.post<TaskEnqueueResponse>("/tasks/graph", body, { params });
        if (res.data?.workspace) syncWorkspaceFromResponse(res.data);
        if (res.data?.result) return res.data.result;
        if (res.data?.task_id) {
          const finalStatus = await pollTaskStatus(res.data.task_id);
          if (finalStatus?.workspace) syncWorkspaceFromResponse(finalStatus);
          return finalStatus.result ?? null;
        }
        return null;
      } catch (error: unknown) {
        if (taskUnavailable(error)) {
          setCanvasStatus(null);
          return null;
        }
        setCanvasStatus(null);
        throw error;
      } finally {
        setCanvasStatus(null);
      }
    },
    [api, pollTaskStatus, preferTaskApi, syncWorkspaceFromResponse]
  );

  const enqueueDiffTask = useCallback(
    async (body: { base: string; head: string; package: string }, params: GraphRequestParams): Promise<unknown | null> => {
      if (!preferTaskApi) return null;
      try {
        setCanvasStatus((prev) => prev ?? "Queued background job…");
        const res = await api.post<TaskEnqueueResponse>("/tasks/graph/diff", body, { params });
        if (res.data?.workspace) syncWorkspaceFromResponse(res.data);
        if (res.data?.result) return res.data.result;
        if (res.data?.task_id) {
          const finalStatus = await pollTaskStatus(res.data.task_id);
          if (finalStatus?.workspace) syncWorkspaceFromResponse(finalStatus);
          return finalStatus.result ?? null;
        }
        return null;
      } catch (error: unknown) {
        if (taskUnavailable(error)) {
          setCanvasStatus(null);
          return null;
        }
        setCanvasStatus(null);
        throw error;
      } finally {
        setCanvasStatus(null);
      }
    },
    [api, pollTaskStatus, preferTaskApi, syncWorkspaceFromResponse]
  );

  const logout = useCallback(() => {
    setToken("");
    setWorkspace(null);
    workspaceStateRef.current = null;
    setUserName(null);
    setSessionChecked(true);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("schema-uml-token");
      window.localStorage.removeItem("schema-uml-username");
    }
  }, []);

  const normalizePackageName = useCallback((value?: string | null) => {
    if (!value) return "";
    return normalizeModule(value) || value;
  }, []);

  const filterActiveAuditForPackage = useCallback(
    (entries: AuditTrailEntry[], targetPackage?: string | null) => {
      const normalizedTarget = normalizePackageName(targetPackage);
      return entries.filter(
        (e) =>
          e?.change &&
          e.replayable !== false &&
          (!e.package || normalizePackageName(e.package) === normalizedTarget)
      );
    },
    [normalizePackageName]
  );

  const archiveAuditTrail = useCallback(() => {
    setAuditTrail((prev) => prev.map((entry) => ({ ...entry, replayable: false })));
  }, []);

  const archiveAllAuditEntries = useCallback(() => {
    setAuditTrail((prev) =>
      prev.length ? prev.map((entry) => ({ ...entry, replayable: false })) : prev
    );
  }, [setAuditTrail]);

  const appendAudit = useCallback(
    (change: AuditTrailEntry["change"], description: string) => {
      const now = new Date().toISOString();
      const id = `${now}-${Math.random().toString(16).slice(2)}`;
      const pkgForEntry = graph?.package || pkg;
      setAuditTrail((prev) => [
        ...prev,
        { change, description, id, timestamp: now, package: pkgForEntry, replayable: true },
      ]);
    },
    [graph, pkg]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (token) {
      window.localStorage.setItem("schema-uml-token", token);
    } else {
      window.localStorage.removeItem("schema-uml-token");
    }
  }, [token]);

  const loadSchemaVersion = useCallback(async (
    opts?: { silent?: boolean; promoteLight?: boolean }
  ): Promise<boolean> => {
    try {
      const res = await api.get("/schema/version");
      setSchemaVersion(res.data?.version || null);
      setSchemaSource(res.data?.source || null);
      setSendDesignEnabled(Boolean(res.data?.send_design_enabled));
      if (opts?.promoteLight && !isLightMode) {
        setRuntimeLightMode(true);
        setToken("light");
        setUserName("local");
        setSessionChecked(true);
        applyWorkspace({ branch: DEFAULT_BRANCH, package: DEFAULT_PACKAGE, base_namespace: DEFAULT_NAMESPACE });
      }
      return true;
    } catch (error) {
      setSendDesignEnabled(false);
      if (!opts?.silent) {
        setSchemaUpdateStatus(`Schema version unavailable: ${formatApiError(error)}`);
      }
      return false;
    }
  }, [api, applyWorkspace, isLightMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (userName) {
      window.localStorage.setItem("schema-uml-username", userName);
    } else {
      window.localStorage.removeItem("schema-uml-username");
    }
  }, [userName]);

  useEffect(() => {
    if (isLightMode) {
      setSessionChecked(true);
      applyWorkspace({ branch: DEFAULT_BRANCH, package: DEFAULT_PACKAGE, base_namespace: DEFAULT_NAMESPACE });
      loadSchemaVersion({ promoteLight: true });
      return;
    }
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (!cancelled) setSessionChecked(true);
    }, 5000);

    const run = async () => {
      const detectedLight = await loadSchemaVersion({ silent: true, promoteLight: true });
      if (cancelled || detectedLight) return;
      if (!token) {
        setWorkspace(null);
        workspaceStateRef.current = null;
        setUserName(null);
        setSessionChecked(true);
        return;
      }
      try {
        const res = await api.get("/workspace");
        if (cancelled) return;
        applyWorkspace(res.data.workspace as WorkspaceState);
        setAuthError(null);
        setUserName((prev) => res.data?.user?.username || prev || null);
      } catch (error: unknown) {
        if (cancelled) return;
        setAuthError(formatApiError(error));
        logout();
      } finally {
        if (!cancelled) setSessionChecked(true);
      }
    };

    run();
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [api, applyWorkspace, isLightMode, loadSchemaVersion, logout, token]);

  useEffect(() => {
    if (!sessionChecked) return;
    loadSchemaVersion({ silent: !isLightMode, promoteLight: true });
  }, [isLightMode, loadSchemaVersion, sessionChecked]);

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const clampDocWidth = useCallback((value: number) => {
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect()?.width ?? 0;
    const minGraphWidth = 380;
    const maxByViewport = workspaceWidth
      ? Math.max(260, workspaceWidth - minGraphWidth - 10)
      : 640;

    return clamp(value, 260, Math.min(640, maxByViewport));
  }, []);

  const setSidebarWidthClamped = useCallback(
    (value: number) => setSidebarWidth(clamp(value, 260, 520)),
    []
  );
  const setDocPanelWidthClamped = useCallback(
    (value: number) => setDocPanelWidth(clampDocWidth(value)),
    [clampDocWidth]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("schema-uml-left-width", String(clamp(sidebarWidth, 260, 520)));
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("schema-uml-doc-width", String(clampDocWidth(docPanelWidth)));
  }, [clampDocWidth, docPanelWidth]);

  useEffect(() => {
    if (!graphHandle) return;

    graphHandle.refit();
    const t1 = window.setTimeout(() => graphHandle.refit(), 120);
    const t2 = window.setTimeout(() => graphHandle.refit(), 360);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [graphHandle, sidebarWidth, docPanelWidth]);

  useEffect(() => {
    setDocPanelWidth((w) => clampDocWidth(w));
  }, [clampDocWidth]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      setDocPanelWidth((w) => clampDocWidth(w));
    });

    if (workspaceRef.current) observer.observe(workspaceRef.current);

    return () => observer.disconnect();
  }, [clampDocWidth]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    try {
      const endpoint = authMode === "register" ? "/auth/register" : "/auth/login";
      const res = await axios.post(`${apiBase}${endpoint}`, {
        username: loginUsername,
        password: loginPassword,
      });
      const nextToken = res.data.access_token as string;
      setToken(nextToken);
      setUserName(res.data.user?.username ?? loginUsername);
      applyWorkspace(res.data.workspace as WorkspaceState);
      setSessionChecked(true);
    } catch (error: unknown) {
      const detail = axios.isAxiosError(error) ? error.response?.data?.detail : undefined;
      setAuthError((detail && String(detail)) || formatApiError(error) || String(error));
    }
  };

  useEffect(() => {
    if (!workspace || !token) return;
    const updates: Partial<WorkspaceState> = {};
    const desiredBranch = isLightMode ? workspace.branch : (packageBranch || workspace.branch);
    if (workspace.package !== pkg) updates.package = pkg;
    if (workspace.base_namespace !== normalizedNamespace) updates.base_namespace = normalizedNamespace;
    if (!isLightMode && workspace.branch !== desiredBranch) updates.branch = desiredBranch;
    if (Object.keys(updates).length > 0) updateWorkspaceOnServer(updates);
  }, [isLightMode, normalizedNamespace, packageBranch, pkg, token, updateWorkspaceOnServer, workspace]);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = appShellRef.current?.getBoundingClientRect();
    const offsetLeft = rect?.left ?? 0;

    const onMove = (evt: MouseEvent) => {
      const next = evt.clientX - offsetLeft;
      setSidebarWidthClamped(next);
    };

    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  const helpSummary = useMemo(
    () => {
      const lines = [
        "Workspace (left): pick package, root, toggles; then Build graph.",
        "Graph canvas (center): pan/zoom, select classes, toggle UML/Edit.",
        "Documentation (right): class and quantity docs; edit quantities in Edit mode.",
        "Audit trail (right bottom): log of edits; export/reset.",
      ];
      if (!isLightMode) lines.push("Compare branches (left): diff two git branches.");
      lines.push("Empty canvas: start custom schema without loading existing graph.");
      return lines;
    },
    [isLightMode]
  );

  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  const focusAndOpen = useCallback((section: "workspace" | "documentation" | "audit" | "compare" | "under" ) => {
    const mapping: Record<typeof section, { setter: (v: boolean) => void; elementId: string }> = {
      workspace: { setter: setOpenWorkspace, elementId: "section-workspace" },
      documentation: { setter: setOpenDocumentation, elementId: "section-documentation" },
      audit: { setter: setOpenAuditTrail, elementId: "section-audit" },
      compare: { setter: setOpenCompare, elementId: "section-compare" },
      under: { setter: setOpenUnderTheHood, elementId: "section-under" },
    };

    const target = mapping[section];
    target.setter(true);
    const el = document.getElementById(target.elementId);
    if (el) {
      const behavior: ScrollBehavior =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth";
      el.scrollIntoView({ behavior, block: "start" });
      const headerBtn = el.querySelector("button.collapsible-header") as HTMLButtonElement | null;
      headerBtn?.focus({ preventScroll: true });
    }
  }, []);

  const startDocResize = (e: React.MouseEvent) => {
    e.preventDefault();

    const onMove = (evt: MouseEvent) => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = rect.right - evt.clientX;
      setDocPanelWidthClamped(next);
    };

    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  // roots for selected package
  const loadRoots = useCallback(async () => {
    if (!token) return;
    if (startEmpty) {
      setRoots([]);
      setRoot("");
      return;
    }
    setErr(null);
    try {
      const r = await api.get("/roots", { params: { package: pkg } });
      const list = r.data.sections || [];
      setRoots(list);
      if (list.length > 0 && !list.includes(root)) setRoot(list[0]);
      syncWorkspaceFromResponse(r.data);
    } catch (e: unknown) {
      setErr(formatApiError(e));
      setRoots([]);
    }
  }, [api, pkg, root, startEmpty, syncWorkspaceFromResponse, token]);

  // build single-branch graph (resets diff view)
  const loadGraph = useCallback(async (
    overrides?: { pkg?: string; root?: string; namespace?: string; branch?: string; forceEmpty?: boolean }
  ) => {
    if (!token) {
      setErr("Login required");
      return;
    }
    const pkgToUse = overrides?.pkg ?? pkg;
    const rootToUse = overrides?.root ?? root;
    const namespaceToUse = overrides?.namespace ?? normalizedNamespace;
    const branchToUse = overrides?.branch ?? workspaceBranch ?? "";
    const useEmpty = overrides?.forceEmpty ?? startEmpty;
    if (!useEmpty) {
      setStartEmpty(false);
      setEditableMode(false);
      setCanvasStatus(null);
    }
    setErr(null);
    setQuantityActionErr(null);
    setLoading(true);
    setDiffData(null);
    setGraphHandle(null);
    try {
      let parsed: ApiGraph | null = null;
      if (useEmpty) {
        const r = await api.get("/schema", {
          params: {
            package: pkgToUse,
            root: rootToUse,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: namespaceToUse || undefined,
            empty: true,
          },
        });
        parsed = ensureGraphResponse(r.data);
        syncWorkspaceFromResponse(r.data);
        setGraph(parsed);
        setBaseGraph(parsed);
        return;
      }
      if (isLightMode) {
        const r = await api.get("/schema", {
          params: {
            package: pkgToUse,
            root: rootToUse,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: namespaceToUse || undefined,
          },
        });
        parsed = ensureGraphResponse(r.data);
        syncWorkspaceFromResponse(r.data);
      } else if (branchToUse) {
        const asyncResult = await enqueueGraphTask(
          { branch: branchToUse, package: pkgToUse },
          {
            root: rootToUse,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: namespaceToUse || undefined,
          }
        );
        if (asyncResult) {
          const maybeGraph = (asyncResult as { graph?: unknown })?.graph ?? asyncResult;
          parsed = ensureGraphResponse(maybeGraph);
          syncWorkspaceFromResponse(asyncResult as WorkspaceEnvelope);
        }
        if (!parsed) {
          const r = await api.post(
            "/graph",
            {
              branch: branchToUse,
              package: pkgToUse,
            },
            {
              params: {
                root: rootToUse,
                include_quantities: includeQuantities,
                include_subsections: includeSubsections,
                include_inheritance: includeInheritance,
                allow_cross_module: crossModules,
                base_namespace: namespaceToUse || undefined,
              },
            }
          );
          parsed = ensureGraphResponse(r.data?.graph ?? r.data);
          syncWorkspaceFromResponse(r.data);
        }
      } else {
        const r = await api.get("/schema", {
          params: {
            package: pkgToUse,
            root: rootToUse,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: namespaceToUse || undefined,
          },
        });
        parsed = ensureGraphResponse(r.data);
        syncWorkspaceFromResponse(r.data);
      }
      setGraph(parsed);
      setBaseGraph(parsed);
      // If the server returned a clean graph without applied persisted edits, archive any local audit history
      // so “active edits” reflects only new work in this session.
      if (!parsed.applied_edits || parsed.applied_edits.length === 0) {
        archiveAllAuditEntries();
      }
    } catch (e: unknown) {
      const message = formatApiError(e);
      setErr(message || "Failed to load graph");
      setGraph(null);
      setBaseGraph(null);
    } finally {
      setLoading(false);
    }
  }, [api, archiveAllAuditEntries, crossModules, enqueueGraphTask, includeQuantities, includeSubsections, includeInheritance, isLightMode, normalizedNamespace, pkg, root, setStartEmpty, startEmpty, syncWorkspaceFromResponse, token, workspaceBranch]);

  const resetEmptyCanvas = useCallback(async () => {
    if (!token) {
      setErr("Login required");
      return;
    }
    const targetPkg = scratchPackage;
    try {
      setCanvasStatus("Resetting canvas…");
      setErr(null);
      await api.delete("/schema/custom-edits", {
        params: {
          package: targetPkg,
          branch: workspaceBranch || undefined,
        },
      });
      archiveAuditTrail();
      setGraph(null);
      setBaseGraph(null);
      setUmlState(null);
      setSelected(null);
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      await loadGraph({ pkg: targetPkg, root: "", namespace: normalizedNamespace, branch: workspaceBranch, forceEmpty: true });
      setCanvasStatus("Canvas reset to empty.");
    } catch (e: unknown) {
      setCanvasStatus(`Reset failed: ${formatApiError(e)}`);
    }
  }, [api, archiveAuditTrail, loadGraph, normalizedNamespace, scratchPackage, setSelected, token, workspaceBranch]);

  // fetch git branches
  const loadBranches = useCallback(async () => {
    if (!token) return;
    if (isLightMode) {
      const fixedBranch = workspaceBranch || DEFAULT_BRANCH;
      setBranches([fixedBranch]);
      setBaseBranch(fixedBranch);
      setHeadBranch(fixedBranch);
      return;
    }
    try {
      const r = await api.get("/git/branches", { params: { base_package: normalizedNamespace } });
      setBranches(r.data.branches || []);
      syncWorkspaceFromResponse(r.data);
    } catch (e) {
      // keep silent in UI; dropdown will just be empty
      console.error("Failed to load branches", e);
    }
  }, [api, isLightMode, normalizedNamespace, syncWorkspaceFromResponse, token, workspaceBranch]);

  // fetch available schema packages from develop branch
  const loadPackages = useCallback(async () => {
    if (!token) return;
    setErr(null);
    try {
      const r = await api.get("/git/packages", {
        params: {
          branch: isLightMode ? undefined : packageBranch,
          base_package: normalizedNamespace,
        },
      });
      const raw: string[] = r.data.packages || [];
      const filtered = raw.filter((p: string) => !p.endsWith(".__init__"));
      const list = (filtered.length ? filtered : raw).filter(Boolean);
      const augmented = startEmpty && scratchPackage ? [scratchPackage, ...list] : list;
      // dedupe while preserving order
      const seen = new Set<string>();
      const unique = augmented.filter((p) => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      });
      setAvailablePkgs(unique);
      syncWorkspaceFromResponse(r.data);

      // if current pkg is not in the list, default to the first entry (keep scratch when empty)
      if (unique.length > 0 && !unique.includes(pkg)) {
        setPkg(startEmpty && scratchPackage ? scratchPackage : unique[0]);
      }
    } catch (e) {
      // silent failure is fine; user can still type manually
      console.error("Failed to load packages", e);
      // surface the error so users know why the dropdown is empty
      setErr(formatApiError(e));
    }
  }, [api, isLightMode, normalizedNamespace, packageBranch, pkg, scratchPackage, setPkg, startEmpty, syncWorkspaceFromResponse, token]);

  useEffect(() => {
    if (!workspace || !token) return;
    loadBranches();
    loadPackages();
    loadRoots();
  }, [loadBranches, loadPackages, loadRoots, token, workspace]);

  // compare base/head using same filters as sidebar
  const compareBranches = async () => {
    if (!token) {
      setErr("Login required");
      return;
    }
    if (isLightMode) {
      setErr("Branch comparison is disabled in Light Mode.");
      return;
    }
    if (!baseBranch || !headBranch) return;
    setErr(null);
    setQuantityActionErr(null);
    setDiffLoading(true);
    setGraph(null); // switch to diff mode
    setGraphHandle(null);
    try {
      const params = {
        root,
        include_quantities: includeQuantities,
        include_subsections: includeSubsections,
        include_inheritance: includeInheritance,
        allow_cross_module: crossModules,
        base_namespace: normalizedNamespace || undefined,
      };

      const asyncResult = await enqueueDiffTask(
        { base: baseBranch, head: headBranch, package: pkg },
        params
      );
      const responseData = asyncResult
        ? asyncResult
        : (
          await api.post(
            "/graph/diff",
            {
              base: baseBranch,
              head: headBranch,
              package: pkg,
            },
            { params }
          )
        ).data;

      const parsed = ensureDiffResponse(responseData);
      setDiffData(parsed);
      syncWorkspaceFromResponse(responseData);
    } catch (e: unknown) {
      setErr(formatApiError(e));
      setDiffData(null);
    } finally {
      setDiffLoading(false);
    }
  };

  const buildUmlState = useCallback((g: ApiGraph | null): UmlGraphState | null => buildUmlStateFromGraph(g), []);

  const seedAuditFromAppliedEdits = useCallback(
    (graphWithEdits: ApiGraph | null) => {
      if (!graphWithEdits) return;

      setAuditTrail((prev) => {
        // Never keep server-seeded persisted entries in the client audit panel.
        const pruned = prev.filter(
          (entry) => !(typeof entry.id === "string" && entry.id.startsWith("persisted-"))
        );
        return pruned.length === prev.length ? prev : pruned;
      });
    },
    [setAuditTrail]
  );

  const toggleEmptyMode = useCallback(async () => {
    const nextShouldBeEmpty = !emptyCanvasActive;
    setStartEmpty(nextShouldBeEmpty);
    if (nextShouldBeEmpty) {
      const targetPkg = scratchPackage;
      const persistedCustom = auditTrail.length === 0 && (graph?.package === targetPkg || baseGraph?.package === targetPkg);
      if (persistedCustom) {
        // If we have stale custom edits but no audit trail (e.g., after refresh), wipe them so the canvas truly starts empty.
        await resetEmptyCanvas();
        return;
      }
      const blankGraph: ApiGraph = { package: targetPkg, root: "", nodes: [], edges: [] };
      setMode("graph");
      setDiffData(null);
      setGraphHandle(null);
      archiveAuditTrail();
      setGraph(blankGraph);
      setBaseGraph(blankGraph);
      setUmlState(buildUmlState(blankGraph));
      setSelected(null);
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      setRoot("");
      setPkg(targetPkg);
      setEditableMode(true);
      setCanvasStatus(null);
      await loadGraph({ pkg: targetPkg, root: "", namespace: normalizedNamespace, forceEmpty: true });
    } else {
      await loadGraph({ forceEmpty: false });
    }
  }, [archiveAuditTrail, auditTrail.length, baseGraph?.package, buildUmlState, emptyCanvasActive, graph?.package, loadGraph, normalizedNamespace, resetEmptyCanvas, scratchPackage, setPkg, setSelected, setStartEmpty]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("schema-uml-theme", theme);
  }, [theme]);

  useEffect(() => {
    setUmlState(buildUmlState(graph));
  }, [buildUmlState, graph]);

  useEffect(() => {
    seedAuditFromAppliedEdits(graph);
  }, [graph, seedAuditFromAppliedEdits]);

  useEffect(() => {
    if (!auditTrail.length && graph) {
      setBaseGraph(graph);
    }
  }, [auditTrail.length, graph]);

  // Archive audit entries that are already reflected in the server-provided baseline graph
  // (so the "active" list only shows changes not yet persisted). We purposely compare against
  // the baseline graph, not the current in-memory graph, otherwise freshly applied edits would
  // be mis-flagged as archived immediately after the user makes them.
  const archiveStaleAuditEntries = useCallback(
    (baseline: ApiGraph | null) => {
      if (!baseline) return;
      const classIds = new Set(
        baseline.nodes.filter((n) => n.kind === "section").map((n) => normalizeId(n.id))
      );
      const quantityIds = new Set(
        baseline.nodes.filter((n) => n.kind === "quantity").map((n) => normalizeId(n.id))
      );

      setAuditTrail((prev) => {
        let mutated = false;
        const next = prev.map((entry) => {
          if (entry.replayable === false) return entry;
          const isServerSeeded = typeof entry.id === "string" && entry.id.startsWith("persisted-");
          if (!isServerSeeded) return entry;
          const change = entry.change;
          const applied = (() => {
            switch (change.type) {
              case "add-class":
                // Change is already reflected if class is present.
                return classIds.has(normalizeId(change.cls.id));
              case "remove-class":
                // Reflected if class is gone.
                return !classIds.has(normalizeId(change.cls.id));
              case "edit-class":
                // Reflected if the edited class is present.
                return classIds.has(normalizeId(change.after.id));
              case "add-quantity":
                // Reflected if quantity is present.
                return quantityIds.has(normalizeId(change.quantity.id));
              case "remove-quantity":
                // Do not auto-archive removals; keep them active so users can undo
                // even when the baseline graph is missing that quantity (e.g., filtered loads).
                return false;
              case "edit-quantity":
                // Reflected if the updated quantity exists.
                return quantityIds.has(normalizeId(change.after.id));
              default:
                return false;
            }
          })();
          // If the change is already applied in the server graph, archive it.
          if (applied) {
            mutated = true;
            return { ...entry, replayable: false };
          }
          return entry;
        });
        return mutated ? next : prev;
      });
    },
    [setAuditTrail]
  );

  useEffect(() => {
    archiveStaleAuditEntries(baseGraph);
  }, [archiveStaleAuditEntries, baseGraph]);

  useEffect(() => {
    if (!umlState) {
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      setSelected(null);
      return;
    }
    if (selectedClassId && !umlState.classes.some((c) => c.id === selectedClassId)) {
      setSelectedClassId(null);
      setSelectedQuantityId(null);
      setSelected(null);
      return;
    }
    if (
      selectedClassId &&
      selectedQuantityId &&
      !umlState.classes.some((c) => c.id === selectedClassId && c.quantities.some((q) => q.id === selectedQuantityId))
    ) {
      setSelectedQuantityId(null);
    }
  }, [selectedClassId, selectedQuantityId, setSelected, umlState]);

  useEffect(() => {
    if (!umlState) {
      setSelected(null);
      return;
    }
    if (!selectedClassId) {
      setSelected(null);
      return;
    }
    const cls = umlState.classes.find((c) => c.id === selectedClassId);
    if (!cls) {
      setSelected(null);
      return;
    }
    if (selectedQuantityId) {
      const qty = cls.quantities.find((q) => q.id === selectedQuantityId);
      if (!qty) {
        setSelected({
          id: cls.id,
          fqid: cls.module && cls.name ? `${cls.module}.${cls.name}` : cls.id,
          kind: "class",
          name: cls.name,
          doc: cls.doc || "",
          path: cls.path || undefined,
          line: typeof cls.line === "number" ? cls.line : undefined,
          quantities: cls.quantities.map((q) => ({
            id: q.id,
            name: q.name,
            dtype: q.dtype,
            shape: q.shape ?? undefined,
            card: q.card ?? undefined,
            doc: q.doc ?? undefined,
            path: q.path ?? undefined,
            line: typeof q.line === "number" ? q.line : undefined,
            owner: q.ownerId,
            inherited: q.inherited ?? false,
            inheritedFromId: q.inheritedFromId ?? null,
            inheritedFromName: q.inheritedFromName ?? null,
            sourceId: q.sourceId ?? null,
          })),
        });
        return;
      }
      setSelected({
        id: qty.id,
        kind: "quantity",
        name: qty.name,
        doc: qty.doc || "",
        path: qty.path || undefined,
        line: typeof qty.line === "number" ? qty.line : undefined,
        dtype: qty.dtype,
        shape: qty.shape ?? undefined,
        card: qty.card ?? undefined,
        owner: cls.id,
        inherited: qty.inherited ?? false,
        inheritedFromId: qty.inheritedFromId ?? null,
        inheritedFromName: qty.inheritedFromName ?? null,
        sourceId: qty.sourceId ?? null,
      });
      return;
    }
    setSelected({
      id: cls.id,
      fqid: cls.module && cls.name ? `${cls.module}.${cls.name}` : cls.id,
      kind: "class",
      name: cls.name,
      doc: cls.doc || "",
      path: cls.path || undefined,
      line: typeof cls.line === "number" ? cls.line : undefined,
      quantities: cls.quantities.map((q) => ({
        id: q.id,
        name: q.name,
        dtype: q.dtype,
        shape: q.shape ?? undefined,
        card: q.card ?? undefined,
        doc: q.doc ?? undefined,
        path: q.path ?? undefined,
        line: typeof q.line === "number" ? q.line : undefined,
        owner: q.ownerId,
        inherited: q.inherited ?? false,
        inheritedFromId: q.inheritedFromId ?? null,
        inheritedFromName: q.inheritedFromName ?? null,
        sourceId: q.sourceId ?? null,
      })),
    });
  }, [selectedClassId, selectedQuantityId, setSelected, umlState]);

  const createQuantityOnCanvas = async (classId: string, { quantityName, dtype, docstring }: QuantityFormData) => {
    const currentGraph = ensureEditableReady();
    if (!currentGraph) {
      throw new Error(addBlockedReason || "Canvas is not editable");
    }
    if (!token) {
      const message = "Login required";
      setQuantityActionErr(message);
      throw new Error(message);
    }
    const targetClass = umlState?.classes.find((c) => c.id === classId);
    if (!targetClass) {
      const message = "Select a class to add the quantity.";
      setQuantityActionErr(message);
      throw new Error(message);
    }

    setCreatingQuantityFor(classId);
    setQuantityActionErr(null);
    try {
      const targetPackage = targetClass.module || pkg;
      const rawName = targetClass.name || targetClass.id || classId;
      const classLabel =
        rawName && rawName.includes(".") ? rawName.split(".").pop() || rawName : rawName;

      const parentLabel =
        targetClass.parentId
          ? umlState?.classes.find((c) => c.id === targetClass.parentId)?.name ||
            targetClass.parentId.split(".").pop() ||
            targetClass.parentId
          : null;
      const parentRelation = targetClass.parentRelation ?? null;

      if (!classLabel) {
        const message = "Target class name missing";
        setQuantityActionErr(message);
        throw new Error(message);
      }
      const trimmedQuantityName = quantityName.trim();
      const visibleNameConflict = targetClass.quantities.find((q) => q.name === trimmedQuantityName);
      if (visibleNameConflict) {
        const inheritedFrom = visibleNameConflict.inheritedFromName || visibleNameConflict.inheritedFromId;
        const message = visibleNameConflict.inherited
          ? `Quantity '${trimmedQuantityName}' is inherited from ${inheritedFrom || "a parent class"} and cannot be redefined on ${targetClass.name}.`
          : `A quantity named '${trimmedQuantityName}' already exists on ${targetClass.name}.`;
        setQuantityActionErr(message);
        throw new Error(message);
      }

      const r = await api.post(
        "/schema/custom-quantity",
        {
          package: targetPackage,
          class_name: classLabel,
          parent_name: parentLabel,
          parent_relation: parentRelation,
          quantity_name: trimmedQuantityName,
          dtype,
          docstring: docstring || null,
        },
        {
          params: {
            root,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: normalizedNamespace || undefined,
            empty: startEmpty ? true : undefined,
          },
        }
      );
      const updated = ensureGraphResponse(r.data);
      const newChange: AuditTrailEntry["change"] = {
        type: "add-quantity",
        classId: targetClass.id,
        quantity: {
          id: `${targetClass.id}.${trimmedQuantityName}`,
          name: trimmedQuantityName,
          dtype,
          doc: docstring || null,
          ownerId: targetClass.id,
          shape: null,
          card: null,
          path: null,
          line: null,
        },
      };

      const mergedGraph = replayGraphWithAudit(updated, newChange);

      setGraph(mergedGraph);
      const nextUml = buildUmlState(mergedGraph);
      setUmlState(nextUml);
      syncWorkspaceFromResponse(mergedGraph);
      const updatedClass =
        nextUml?.classes?.find(
          (c) =>
            c.id === targetClass.id ||
            c.name === targetClass.name ||
            c.id?.endsWith?.(`.${targetClass.name}`) ||
            c.name?.endsWith?.(`.${targetClass.name}`)
        ) ?? targetClass;

      const addedQuantity =
        nextUml?.classes
          ?.find(
            (c) =>
              c.id === updatedClass.id ||
              c.name === updatedClass.name ||
              c.name?.endsWith?.(`.${updatedClass.name}`)
          )
          ?.quantities.find(
            (q) => q.name === trimmedQuantityName || q.id === `${updatedClass.id}.${trimmedQuantityName}`
          ) ??
        ({
          id: `${updatedClass.id}.${trimmedQuantityName}`,
          name: trimmedQuantityName,
          dtype,
          doc: docstring || null,
          ownerId: updatedClass.id,
          shape: null,
          card: null,
          path: null,
          line: null,
        } as QuantityNode);

      appendAudit(
        { type: "add-quantity", classId: updatedClass.id, quantity: addedQuantity },
        `Added quantity ${addedQuantity.name}${dtype ? `: ${dtype}` : ""} to class ${updatedClass.name}`
      );
      setSelectedClassId(updatedClass.id);
      setSelectedQuantityId(addedQuantity.id);
    } catch (e: unknown) {
      const message = formatApiError(e);
      setQuantityActionErr(message);
      throw new Error(message);
    } finally {
      setCreatingQuantityFor(null);
    }
  };

  const createClassOnCanvas = async ({ name, parentId, docstring, relation, card }: { name: string; parentId?: string | null; docstring?: string; relation?: "inherits" | "hasSubSection"; card?: string }) => {
    const currentGraph = ensureEditableReady();
    if (!currentGraph) {
      throw new Error(addBlockedReason || "Canvas is not editable");
    }
    if (!token) {
      const message = "Login required";
      setQuantityActionErr(message);
      throw new Error(message);
    }
    setCreatingClass(true);
    setQuantityActionErr(null);
    try {
      const classRelation = parentId ? relation || "inherits" : "inherits";
      const subsectionCard = classRelation === "hasSubSection" ? card?.trim() || null : null;
      const res = await api.post(
        "/schema/custom-class",
        {
          package: pkg,
          name,
          parent: parentId || null,
          relation: classRelation,
          card: subsectionCard,
          docstring: docstring || null,
        },
        {
          params: {
            root,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: normalizedNamespace || undefined,
            empty: startEmpty ? true : undefined,
          },
        }
      );
      const next = ensureGraphResponse(res.data);
      const expectedClassId = normalizeId(`${pkg}.${name}`);
      const newChange: AuditTrailEntry["change"] = {
        type: "add-class",
        cls: {
          id: expectedClassId,
          name,
          doc: docstring || null,
          module: pkg,
          parentId: parentId || null,
          parentRelation: parentId ? classRelation : null,
          parentCard: subsectionCard,
          quantities: [],
          path: null,
          line: null,
        } as UmlClassNode,
      };
      const mergedGraph = replayGraphWithAudit(next, newChange);
      setGraph(mergedGraph);
      const nextUml = buildUmlState(mergedGraph);
      setUmlState(nextUml);
      syncWorkspaceFromResponse(mergedGraph);
      const newCls =
        nextUml?.classes.find((c) => normalizeId(c.id) === expectedClassId) ??
        nextUml?.classes.find(
          (c) =>
            normalizeId(c.name) === normalizeId(name) &&
            normalizeModule(c.module) === normalizeModule(pkg)
        ) ??
        ({
          id: expectedClassId,
          name,
          doc: docstring || null,
          module: pkg,
          parentId: parentId || null,
          parentRelation: parentId ? classRelation : null,
          parentCard: subsectionCard,
          quantities: [],
          path: null,
          line: null,
        } as UmlClassNode);
      appendAudit(
        { type: "add-class", cls: newCls },
        parentId ? `Added class ${newCls.name} extending ${parentId}` : `Added class ${newCls.name}`
      );
      setSelectedClassId(newCls.id);
      setSelectedQuantityId(null);
    } catch (e: unknown) {
      const message = formatApiError(e);
      setQuantityActionErr(message);
      throw new Error(message);
    } finally {
      setCreatingClass(false);
    }
  };

  const removeQuantityFromGraphState = useCallback((g: ApiGraph, quantityId: string): ApiGraph => {
    const nodes = (g.nodes || []).filter((n) => n.id !== quantityId);
    const edges = (g.edges || []).filter((e) => e.source !== quantityId && e.target !== quantityId);
    return { ...g, nodes, edges };
  }, []);

  const addQuantityToGraphState = useCallback((g: ApiGraph, quantity: QuantityNode): ApiGraph => {
    const qNode: ApiNode = {
      id: quantity.id,
      kind: "quantity",
      label: quantity.name,
      dtype: quantity.dtype,
      shape: quantity.shape ?? undefined,
      card: quantity.card ?? undefined,
      doc: quantity.doc ?? null,
      owner: quantity.ownerId,
      path: quantity.path ?? undefined,
      line: quantity.line ?? undefined,
    };
    const hasNode = (g.nodes || []).some((n) => n.id === quantity.id);
    const nodes: ApiNode[] = hasNode
      ? (g.nodes || []).map((n) => (n.id === quantity.id ? { ...n, ...qNode } : n))
      : [...(g.nodes || []), qNode];
    const edgeExists = (g.edges || []).some((e) => e.source === quantity.ownerId && e.target === quantity.id);
    const edges: ApiEdge[] = edgeExists
      ? g.edges || []
      : [...(g.edges || []), { source: quantity.ownerId, target: quantity.id, type: "hasQuantity" as const, card: quantity.card ?? null }];
    return { ...g, nodes, edges };
  }, []);

  const removeClassFromGraphState = useCallback((g: ApiGraph, classId: string): ApiGraph => {
    const removedQuantityIds = (g.nodes || []).filter((n) => n.owner === classId).map((n) => n.id);
    const nodes = (g.nodes || []).filter(
      (n) => n.id !== classId && !removedQuantityIds.includes(n.id)
    );
    const edges = (g.edges || []).filter(
      (e) =>
        e.source !== classId &&
        e.target !== classId &&
        !removedQuantityIds.includes(e.source) &&
        !removedQuantityIds.includes(e.target)
    );
    return { ...g, nodes, edges };
  }, []);

  const editClassInGraphState = useCallback((g: ApiGraph, cls: UmlClassNode): ApiGraph => {
    const nodes = (g.nodes || []).map((n) => {
      if (n.kind !== "section" || n.id !== cls.id) return n;
      return { ...n, doc: cls.doc ?? null };
    });
    return { ...g, nodes };
  }, []);

  const addClassToGraphState = useCallback((g: ApiGraph, cls: UmlClassNode): ApiGraph => {
    const nodesWithoutClass = (g.nodes || []).filter((n) => !(n.kind === "section" && n.id === cls.id));
    const sectionNode: ApiNode = {
      id: cls.id,
      kind: "section",
      label: cls.name,
      module: cls.module ?? g.package,
      doc: cls.doc ?? null,
      path: cls.path ?? null,
      line: cls.line ?? null,
    };
    const ownedQuantities = cls.quantities.filter((q) => !q.inherited);
    const qtyNodes: ApiNode[] = ownedQuantities.map((q) => ({
      id: q.id,
      kind: "quantity",
      label: q.name,
      dtype: q.dtype,
      shape: q.shape ?? undefined,
      card: q.card ?? undefined,
      doc: q.doc ?? null,
      owner: q.ownerId,
      path: q.path ?? undefined,
      line: q.line ?? undefined,
    }));
    const qtyEdges: ApiEdge[] = ownedQuantities.map((q) => ({
      source: q.ownerId,
      target: q.id,
      type: "hasQuantity" as const,
      card: q.card ?? null,
    }));
    const relationType: ApiEdge["type"] = cls.parentRelation === "hasSubSection" ? "hasSubSection" : "inherits";
    const parentLinkEdge: ApiEdge[] = cls.parentId
      ? relationType === "inherits"
        ? [{ source: cls.id, target: cls.parentId, type: relationType, card: null }]
        : [{ source: cls.parentId, target: cls.id, type: relationType, card: cls.parentCard ?? null }]
      : [];

    return {
      ...g,
      nodes: [...nodesWithoutClass, sectionNode, ...qtyNodes],
      edges: [
        ...(g.edges || []).filter(
          (e) =>
            !((e.type === "inherits" && e.source === cls.id) || (e.type === "hasSubSection" && e.target === cls.id))
        ),
        ...qtyEdges,
        ...parentLinkEdge
      ],
    };
  }, []);

  const applyForwardChange = useCallback((current: ApiGraph, change: AuditTrailEntry["change"]): ApiGraph => {
    switch (change.type) {
      case "add-class":
        return addClassToGraphState(current, change.cls);
      case "remove-class":
        return removeClassFromGraphState(current, change.cls.id);
      case "edit-class":
        return editClassInGraphState(current, change.after);
      case "add-quantity":
        return addQuantityToGraphState(current, change.quantity);
      case "remove-quantity":
        return removeQuantityFromGraphState(current, change.quantity.id);
      case "edit-quantity": {
        const withoutBefore = removeQuantityFromGraphState(current, change.before.id);
        return addQuantityToGraphState(withoutBefore, change.after);
      }
      default:
        return current;
    }
  }, [addClassToGraphState, addQuantityToGraphState, editClassInGraphState, removeClassFromGraphState, removeQuantityFromGraphState]);

  const replayGraphWithAudit = useCallback(
    (serverGraph: ApiGraph, extraChange?: AuditTrailEntry["change"]): ApiGraph => {
      const targetPackage = normalizePackageName(serverGraph.package) || normalizePackageName(pkg);
      const scopedEntries = filterActiveAuditForPackage(auditTrail, targetPackage);
      const changes = scopedEntries.map((a) => a.change).filter(Boolean) as AuditTrailEntry["change"][];
      const allChanges = extraChange ? [...changes, extraChange] : changes;
      return allChanges.reduce((acc, change) => applyForwardChange(acc, change), serverGraph);
    },
    [applyForwardChange, auditTrail, filterActiveAuditForPackage, normalizePackageName, pkg]
  );

  const rebuildGraphWithAudit = useCallback(
    (entries: AuditTrailEntry[]) => {
      const baseline = baseGraph ?? graph;
      if (!baseline) return;
      const targetPackage = normalizePackageName(baseline.package || pkg);
      const applicable = filterActiveAuditForPackage(entries, targetPackage);
      const rebuilt = applicable.reduce((acc, curr) => applyForwardChange(acc, curr.change), baseline);
      setGraph(rebuilt);
      setUmlState(buildUmlState(rebuilt));
    },
    [applyForwardChange, baseGraph, buildUmlState, filterActiveAuditForPackage, graph, normalizePackageName, pkg]
  );

  const deletePersistedEntryForAudit = useCallback(
    async (entry: AuditTrailEntry) => {
      if (!isLightMode) return;
      const scopedPackage = normalizePackageName(entry.package) || normalizePackageName(pkg) || pkg;
      if (entry.change.type === "add-class") {
        const className =
          entry.change.cls.name || entry.change.cls.id.split(".").pop() || entry.change.cls.id;
        await api.delete("/schema/custom-edit", {
          params: {
            package: scopedPackage,
            class_name: className,
            branch: workspaceBranch || undefined,
          },
        });
      } else if (entry.change.type === "add-quantity") {
        const className =
          entry.change.classId.split(".").pop() ||
          entry.change.classId ||
          entry.change.quantity.ownerId.split(".").pop() ||
          entry.change.quantity.ownerId;
        const quantityName =
          entry.change.quantity.name || entry.change.quantity.id.split(".").pop() || entry.change.quantity.id;
        await api.delete("/schema/custom-edit", {
          params: {
            package: scopedPackage,
            class_name: className,
            quantity_name: quantityName,
            branch: workspaceBranch || undefined,
          },
        });
      }
    },
    [api, isLightMode, normalizePackageName, pkg, workspaceBranch]
  );

  const undoAuditEntry = async (id: string) => {
    const entry = auditTrail.find((a) => a.id === id);
    if (!entry || !entry.change) return;
    const remaining = auditTrail.filter((a) => a.id !== id && a.change);

    setAuditTrail(remaining as AuditTrailEntry[]);
    setQuantityActionErr(null);

    if (isLightMode && (entry.change.type === "add-class" || entry.change.type === "add-quantity")) {
      try {
        await deletePersistedEntryForAudit(entry);
      } catch (e: unknown) {
        setQuantityActionErr(`Undo failed: ${formatApiError(e)}`);
      }
      await loadGraph();
      return;
    }

    rebuildGraphWithAudit(remaining as AuditTrailEntry[]);
  };

  const clearAuditTrail = async () => {
    const hasLocalAudit = auditTrail.length > 0;
    const hasPersistedEdits = (graph?.applied_edits?.length ?? 0) > 0;
    if (!hasLocalAudit && !hasPersistedEdits) return;
    const baseline = baseGraph ?? graph;
    if (baseline) {
      setGraph(baseline);
      setUmlState(buildUmlState(baseline));
    }
    setAuditTrail([]);
    setQuantityActionErr(null);
    try {
      await api.delete("/schema/custom-edits", {
        params: {
          package: isLightMode ? undefined : pkg,
          branch: workspaceBranch || undefined,
          all_packages: isLightMode ? true : undefined,
        },
      });
    } catch (e) {
      console.warn("Failed to clear persisted edits", e);
      return;
    }
    await loadGraph();
  };

  useEffect(() => {
    loadRoots();
  }, [pkg, startEmpty, loadRoots]);

  // If user switches away from the scratch package, exit empty mode to restore schema-backed behavior.
  useEffect(() => {
    if (startEmpty && pkg !== scratchPackage) {
      setStartEmpty(false);
      setEditableMode(false);
      setCanvasStatus(null);
    }
  }, [pkg, scratchPackage, setStartEmpty, startEmpty]);

  useEffect(() => {
    loadBranches();
    loadPackages();
  }, [loadBranches, loadPackages, normalizedNamespace, packageBranch]);

  const selectedClassName = selected?.kind === "class" ? selected.name : null;
  const addBlockedReason =
    mode !== "graph"
      ? "Switch to diagram view to modify quantities"
      : diffData
        ? "Exit branch comparison to modify quantities"
        : !graph
          ? "Build a graph first to modify quantities"
          : null;

  const currentGraph = diffData ? diffData.head?.graph ?? null : graph;
  const currentPackageForAudit = normalizePackageName(currentGraph?.package || pkg);
  const auditEntriesForCurrentPackage = useMemo(
    () =>
      auditTrail.filter(
        (entry) => entry?.change && (!entry.package || normalizePackageName(entry.package) === currentPackageForAudit)
      ),
    [auditTrail, currentPackageForAudit, normalizePackageName]
  );
  const activeAuditEntries = useMemo(
    () => filterActiveAuditForPackage(auditEntriesForCurrentPackage, currentPackageForAudit),
    [auditEntriesForCurrentPackage, currentPackageForAudit, filterActiveAuditForPackage]
  );
  const activeAuditCount = activeAuditEntries.length;
  const archivedAuditCount = auditEntriesForCurrentPackage.length - activeAuditCount;

  // Safety net: re-activate remove-quantity entries that were incorrectly archived
  // by earlier logic, as long as they belong to the current package.
  useEffect(() => {
    if (!auditTrail.length) return;
    setAuditTrail((prev) => {
      let changed = false;
      const normalizedPkg = currentPackageForAudit;
      const next = prev.map((entry) => {
        if (
          entry.replayable === false &&
          entry.change?.type === "remove-quantity" &&
          (!entry.package || normalizePackageName(entry.package) === normalizedPkg)
        ) {
          changed = true;
          return { ...entry, replayable: true };
        }
        return entry;
      });
      return changed ? next : prev;
    });
  }, [auditTrail, currentPackageForAudit, normalizePackageName]);

  const restoreArchivedEntry = (id: string) => {
    const updated = auditTrail.map((entry) =>
      entry.id === id
        ? { ...entry, replayable: true, package: currentPackageForAudit }
        : entry
    );
    setAuditTrail(updated);
    rebuildGraphWithAudit(updated);
  };

  const restoreAllArchivedToCurrent = () => {
    if (!auditTrail.length) return;
    const updated = auditTrail.map((entry) => {
      const onCurrentCanvas = !entry.package || normalizePackageName(entry.package) === currentPackageForAudit;
      if (!onCurrentCanvas || entry.replayable !== false) return entry;
      return {
        ...entry,
        replayable: true,
        package: currentPackageForAudit,
      };
    });
    setAuditTrail(updated);
    rebuildGraphWithAudit(updated);
  };

  const handleBranchSelect = (value: string) => {
    if (isLightMode) return;
    setPackageBranch(value);
    setOverviewBranch(value);
    setBaseBranch((prev) => prev || value);
    setHeadBranch((prev) => prev || value);
    setWorkspaceBranch(value);
    updateWorkspaceOnServer({ branch: value });
  };

  const handlePackageSelect = (value: string) => {
    setPkg(value);
    updateWorkspaceOnServer({ package: value });
  };

  const handleCanvasClassSelect = useCallback((cls: UmlClassNode) => {
    setSelectedClassId(cls.id);
    setSelectedQuantityId(null);
  }, []);

  const handleCanvasClear = useCallback(() => {
    setSelectedClassId(null);
    setSelectedQuantityId(null);
    setSelected(null);
  }, [setSelected]);

  const focusRootSection = useCallback(() => {
    const targetRoot = normalizeId(currentGraph?.root || root);
    if (!targetRoot) return;

    const handled = graphHandle?.focusNode(targetRoot);
    if (handled) return;

    const fallbackNode = currentGraph?.nodes?.find?.((n) => {
      const label = n.label || (n as { rawName?: string }).rawName || "";
      return normalizeId(n.id) === targetRoot || normalizeId(label) === targetRoot;
    });

    if (fallbackNode) {
      const fallbackId = normalizeId(fallbackNode.id);
      const fallbackName = normalizeLabel(
        fallbackNode.label || (fallbackNode as { rawName?: string }).rawName || "",
        fallbackId
      );
      setSelected({
        id: fallbackId,
        kind: "class",
        name: fallbackName,
        doc: fallbackNode.doc || "",
        path: fallbackNode.path || "",
        line: typeof fallbackNode.line === "number" ? fallbackNode.line : undefined,
        fqid: fqidFromParts(fallbackNode.module, fallbackName, fallbackId),
      });
      setSelectedClassId(fallbackId);
      setSelectedQuantityId(null);
    }
  }, [currentGraph, graphHandle, root, setSelected, setSelectedClassId, setSelectedQuantityId]);

  useEffect(() => {
    focusRootSection();
  }, [focusRootSection]);

  const returnToHome = useCallback(() => {
    setMode("graph");
    setGraph(null);
    setBaseGraph(null);
    setDiffData(null);
    setGraphHandle(null);
    setUmlState(null);
    setSelectedClassId(null);
    setSelectedQuantityId(null);
    setSelected(null);
    setCanvasStatus(null);
    setQuantityActionErr(null);
    setCreatingQuantityFor(null);
    setCreatingClass(false);
    setEditableMode(false);
  }, [setSelected]);

  const handleOverviewClassSelect = (pkgName: string, className: string) => {
    setMode("graph");
    setPkg(pkgName);
    setRoot(className);
    setPackageBranch((prev) => prev || overviewBranch);
    setRoots((prev) => (prev.includes(className) ? prev : [className, ...prev]));
    loadGraph({
      pkg: pkgName,
      root: className,
      namespace: normalizedNamespace,
      branch: overviewBranch,
    });
  };

  const ensureEditableReady = () => {
    if (addBlockedReason) {
      setQuantityActionErr(addBlockedReason);
      return null;
    }
    if (!editableMode) {
      setQuantityActionErr("Enable editable mode to make changes.");
      return null;
    }
    if (!graph) {
      setQuantityActionErr("Build a graph first to make changes.");
      return null;
    }
    return graph;
  };

  const findQuantityInUml = useCallback(
    (quantityId: string, ownerHint?: string | null): { cls: UmlClassNode; qty: QuantityNode } | null => {
      if (!umlState) return null;

      const ownerClass = ownerHint ? umlState.classes.find((c) => c.id === ownerHint) ?? null : null;
      const classes = ownerClass ? [ownerClass, ...umlState.classes.filter((c) => c.id !== ownerHint)] : umlState.classes;

      for (const cls of classes) {
        const qty = cls.quantities.find((q) => q.id === quantityId);
        if (qty) return { cls, qty };
      }
      for (const cls of classes) {
        const qty = cls.quantities.find((q) => q.inherited && q.sourceId === quantityId);
        if (qty) return { cls, qty };
      }
      return null;
    },
    [umlState]
  );

  const editClassDoc = async (classId: string, updates: { docstring: string }) => {
    const current = ensureEditableReady();
    if (!current) return;

    const target = current.nodes.find((n) => n.id === classId && n.kind === "section");
    if (!target) {
      setQuantityActionErr("Class not found in current graph.");
      return;
    }

    const targetClass = umlState?.classes.find((c) => c.id === classId);
    const before: UmlClassNode = targetClass ?? {
      id: target.id,
      name: target.label,
      doc: target.doc ?? null,
      module: target.module ?? current.package,
      path: target.path ?? null,
      line: typeof target.line === "number" ? target.line : null,
      quantities: [],
      parentId: null,
      parentRelation: null,
      parentCard: null,
    };
    const after: UmlClassNode = {
      ...before,
      doc: updates.docstring || null,
    };
    const parentName =
      before.parentId
        ? umlState?.classes.find((c) => c.id === before.parentId)?.name ||
          before.parentId.split(".").pop() ||
          before.parentId
        : null;

    try {
      const res = await api.post(
        "/schema/custom-class",
        {
          package: before.module || current.package || pkg,
          name: before.name,
          parent: parentName,
          relation: before.parentId ? before.parentRelation || "inherits" : "inherits",
          card: before.parentRelation === "hasSubSection" ? before.parentCard ?? null : null,
          docstring: updates.docstring || null,
          update_existing: true,
        },
        {
          params: {
            root,
            include_quantities: includeQuantities,
            include_subsections: includeSubsections,
            include_inheritance: includeInheritance,
            allow_cross_module: crossModules,
            base_namespace: normalizedNamespace || undefined,
            empty: startEmpty ? true : undefined,
          },
        }
      );
      const updated = ensureGraphResponse(res.data);
      syncWorkspaceFromResponse(updated);
    } catch (e: unknown) {
      const message = formatApiError(e);
      setQuantityActionErr(message);
      throw new Error(message);
    }

    const nextGraph = {
      ...current,
      nodes: current.nodes.map((n) => (
        n.id === classId && n.kind === "section"
          ? { ...n, doc: updates.docstring || null }
          : n
      )),
    };

    setGraph(nextGraph);
    setQuantityActionErr(null);
    appendAudit(
      { type: "edit-class", before, after },
      `Edited class ${before.name} docstring`
    );

    if (selected?.kind === "class" && selected.id === classId) {
      setSelected({
        ...selected,
        doc: updates.docstring || "",
      });
    }
  };

  const editQuantity = (quantityId: string, updates: QuantityFormData) => {
    const current = ensureEditableReady();
    if (!current) return;
    const ownerHint = selected?.kind === "quantity" ? selected.owner : selectedClassId;
    const umlQuantity = findQuantityInUml(quantityId, ownerHint);
    if (umlQuantity?.qty.inherited) {
      const inheritedFrom = umlQuantity.qty.inheritedFromName || umlQuantity.qty.inheritedFromId || "a parent class";
      setQuantityActionErr(
        `Quantity '${umlQuantity.qty.name}' is inherited from ${inheritedFrom} and cannot be edited on ${umlQuantity.cls.name}.`
      );
      return;
    }

    const target = current.nodes.find((n) => n.id === quantityId && n.kind === "quantity");
    if (!target) {
      setQuantityActionErr("Quantity not found in current graph.");
      return;
    }
    if (!target.owner) {
      setQuantityActionErr("Cannot edit a quantity without an owner.");
      return;
    }

    const trimmedName = updates.quantityName.trim();
    if (!trimmedName) {
      setQuantityActionErr("Quantity name cannot be empty.");
      return;
    }

    const newId = `${target.owner}.${trimmedName}`;
    const ownerClass = umlState?.classes.find((c) => c.id === target.owner);
    const nameConflict = ownerClass?.quantities.find((q) => q.id !== quantityId && q.name === trimmedName);
    const conflict = Boolean(nameConflict) || current.nodes.some(
      (n) => n.kind === "quantity" && n.owner === target.owner && n.id !== quantityId && (n.id === newId || n.label === trimmedName)
    );
    if (conflict) {
      if (nameConflict?.inherited) {
        const inheritedFrom = nameConflict.inheritedFromName || nameConflict.inheritedFromId || "a parent class";
        setQuantityActionErr(
          `A quantity named '${trimmedName}' is inherited from ${inheritedFrom} and cannot be overridden on this class.`
        );
      } else {
        setQuantityActionErr("A quantity with that name already exists on this class.");
      }
      return;
    }

    const nextNodes = current.nodes.map((n) => {
      if (n.id !== quantityId) return n;
      return { ...n, id: newId, label: trimmedName, doc: updates.docstring || null, dtype: updates.dtype };
    });

    const nextEdges = current.edges.map((e) => {
      if (e.source === quantityId) return { ...e, source: newId };
      if (e.target === quantityId) return { ...e, target: newId };
      return e;
    });

    const nextGraph = { ...current, nodes: nextNodes, edges: nextEdges };
    setGraph(nextGraph);
    setQuantityActionErr(null);
    const before: QuantityNode = {
      id: target.id,
      name: target.label,
      dtype: target.dtype ?? target.data_type ?? target.type ?? undefined,
      shape: target.shape ?? null,
      card: target.card ?? null,
      doc: target.doc ?? null,
      path: target.path ?? null,
      line: typeof target.line === "number" ? target.line : null,
      ownerId: target.owner,
    };
    const after: QuantityNode = {
      ...before,
      id: newId,
      name: trimmedName,
      dtype: updates.dtype,
      doc: updates.docstring || null,
    };
    appendAudit(
      { type: "edit-quantity", classId: target.owner, before, after },
      `Edited quantity ${before.name} on ${target.owner}`
    );

    if (selected?.kind === "quantity" && selected.id === quantityId) {
      setSelectedQuantityId(newId);
    }
  };

  const removeQuantity = (quantityId: string) => {
    const current = ensureEditableReady();
    if (!current) return;
    const ownerHint = selected?.kind === "quantity" ? selected.owner : selectedClassId;
    const umlQuantity = findQuantityInUml(quantityId, ownerHint);
    if (umlQuantity?.qty.inherited) {
      const inheritedFrom = umlQuantity.qty.inheritedFromName || umlQuantity.qty.inheritedFromId || "a parent class";
      setQuantityActionErr(
        `Quantity '${umlQuantity.qty.name}' is inherited from ${inheritedFrom} and cannot be removed on ${umlQuantity.cls.name}.`
      );
      return;
    }

    const target = current.nodes.find((n) => n.id === quantityId && n.kind === "quantity");
    if (!target) {
      setQuantityActionErr("Quantity not found in current graph.");
      return;
    }
    if (!target.owner) {
      setQuantityActionErr("Cannot remove a quantity without an owner.");
      return;
    }

    const nextNodes = current.nodes.filter((n) => n.id !== quantityId);
    const nextEdges = current.edges.filter((e) => e.source !== quantityId && e.target !== quantityId);
    const nextGraph = { ...current, nodes: nextNodes, edges: nextEdges };

    setGraph(nextGraph);
    setQuantityActionErr(null);
    const removed: QuantityNode = {
      id: target.id,
      name: target.label,
      dtype: target.dtype ?? target.data_type ?? target.type ?? undefined,
      shape: target.shape ?? null,
      card: target.card ?? null,
      doc: target.doc ?? null,
      path: target.path ?? null,
      line: typeof target.line === "number" ? target.line : null,
      ownerId: target.owner,
    };
    appendAudit(
      { type: "remove-quantity", classId: target.owner, quantity: removed },
      `Removed quantity ${removed.name} from ${target.owner}`
    );

    if (selected?.kind === "quantity" && selected.id === quantityId) {
      setSelectedQuantityId(null);
    }
  };

  const exportJson = () => {
    if (!currentGraph) return;
    void saveExportFile(
      `${currentGraph.package}_${currentGraph.root || "all"}.json`,
      new TextEncoder().encode(JSON.stringify(currentGraph, null, 2)),
      "application/json",
      [{ name: "JSON", extensions: ["json"] }]
    );
  };

  const handleImportJson = () => {
    setImportStatus(null);
    importFileRef.current?.click();
  };

  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    type ImportGraphShape = {
      package?: unknown;
      root?: unknown;
      nodes: unknown[];
      edges: unknown[];
    };

    const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    const hasGraphShape = (value: unknown): value is ImportGraphShape =>
      isObjectRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);

    const extractGraphCandidate = (raw: unknown): Record<string, unknown> => {
      if (Array.isArray(raw)) {
        const looksLikeAuditLog = raw.every(
          (entry) => isObjectRecord(entry) && "change" in entry && "timestamp" in entry
        );
        if (looksLikeAuditLog) {
          throw new Error("This file is an audit log. Import expects a graph export JSON.");
        }
        throw new Error("Expected a graph object, received a JSON array.");
      }
      if (!isObjectRecord(raw)) {
        throw new Error("File is empty or invalid JSON.");
      }
      if (hasGraphShape(raw)) return raw;
      if (hasGraphShape(raw.schema)) return raw.schema;
      if (hasGraphShape(raw.graph)) return raw.graph;
      if (isObjectRecord(raw.head) && hasGraphShape(raw.head.graph)) return raw.head.graph;
      throw new Error("Expected nodes[] and edges[] in the workspace file.");
    };

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result ?? "{}"));
        const candidate = extractGraphCandidate(raw);
        const nextGraph: ApiGraph = {
          package: typeof candidate.package === "string" ? candidate.package : pkg,
          root: typeof candidate.root === "string" || candidate.root === null ? (candidate.root as string | null) : null,
          nodes: candidate.nodes as ApiNode[],
          edges: candidate.edges as ApiEdge[],
        };
        setMode("graph");
        setDiffData(null);
        setGraphHandle(null);
        setGraph(nextGraph);
        setBaseGraph(nextGraph);
        const nextUml = buildUmlState(nextGraph);
        setUmlState(nextUml);
        archiveAuditTrail();
        setSelectedClassId(null);
        setSelectedQuantityId(null);
        setSelected(null);
        if (nextGraph.package) setPkg(nextGraph.package);
        if (nextGraph.root) setRoot(nextGraph.root);
        setImportStatus(`Imported ${file.name}`);
        setErr(null);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Invalid workspace file.";
        setImportStatus(`Import failed: ${message}`);
      } finally {
        e.target.value = "";
      }
    };
    reader.onerror = () => {
      setImportStatus("Import failed: could not read the file.");
      e.target.value = "";
    };
    reader.readAsText(file);
  };

  const saveExportFile = useCallback(
    async (filename: string, data: Uint8Array, mimeType: string, filters: ExportFilter[]) => {
      try {
        const selected = await save({
          defaultPath: filename,
          filters,
        });
        const targetPath = Array.isArray(selected) ? selected[0] : selected;
        if (!targetPath) return;
        await writeFile(targetPath, data);
      } catch {
        const browserBytes = new Uint8Array(data.byteLength);
        browserBytes.set(data);
        triggerBrowserDownload(new Blob([browserBytes], { type: mimeType }), filename);
      }
    },
    []
  );

  const exportPdf = () => {
    if (!currentGraph || !graphHandle) return;

    const png = graphHandle.toPng();
    if (!png) return;

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const props = pdf.getImageProperties(png);

    const ratio = Math.min(pageWidth / props.width, pageHeight / props.height);
    const w = props.width * ratio;
    const h = props.height * ratio;
    const x = (pageWidth - w) / 2;
    const y = (pageHeight - h) / 2;

    pdf.addImage(png, "PNG", x, y, w, h);
    void saveExportFile(
      `${currentGraph.package}_${currentGraph.root || "all"}.pdf`,
      new Uint8Array(pdf.output("arraybuffer")),
      "application/pdf",
      [{ name: "PDF", extensions: ["pdf"] }]
    );
  };

  const exportAuditLog = () => {
    if (!auditTrail.length) return;
    void saveExportFile(
      "schema-uml-audit-log.json",
      new TextEncoder().encode(JSON.stringify(auditTrail, null, 2)),
      "application/json",
      [{ name: "JSON", extensions: ["json"] }]
    );
  };

  const sendDesign = async () => {
    if (!sendDesignEnabled) {
      setSendStatus("Send design is disabled. Set SCHEMA_STUDIO_SEND_ENDPOINT to enable it.");
      return;
    }
    if (!graph && !baseGraph) {
      setSendStatus("Nothing to send yet — build a graph first.");
      return;
    }
    setSending(true);
    setSendStatus(null);
    try {
      const payload = {
        schema: graph ?? baseGraph,
        note: sendNote || undefined,
        timestamp: new Date().toISOString(),
      };
      const res = await api.post("/send-design", payload);
      const id = (res.data && (res.data.submission_id as string)) || undefined;
      setSendStatus(id ? `Results sent. Reference: ${id}` : "Results sent.");
    } catch (error: unknown) {
      setSendStatus(`Send failed: ${formatApiError(error)}`);
    } finally {
      setSending(false);
    }
  };

  const updateSchema = async () => {
    setSchemaUpdating(true);
    setSchemaUpdateStatus(null);
    try {
      const res = await api.post("/schema/update");
      const version = res.data?.version as string | undefined;
      setSchemaVersion(version || null);
      setSchemaSource(res.data?.source || null);
      setSchemaUpdateStatus(version ? `Schema updated to ${version}` : "Schema updated.");
    } catch (error) {
      setSchemaUpdateStatus(`Update failed: ${formatApiError(error)}`);
    } finally {
      setSchemaUpdating(false);
    }
  };

  const restoring = token && !sessionChecked;

  if (!token || !sessionChecked || !userName) {
    return (
      <main className="app-shell" ref={appShellRef} style={{ gridTemplateColumns: `${sidebarWidth}px 10px 1fr` }}>
        <div className="sidebar" style={{ gridColumn: "1 / span 3", padding: 24 }}>
          <h2>{restoring ? "Restoring session…" : authMode === "register" ? "Create account" : "Sign in"}</h2>
          <p className="subdued">
            {restoring
              ? "Checking saved credentials. If this hangs, sign in again."
              : authMode === "register"
                ? "Pick a username and password to create your workspace."
                : "Authenticate to load your workspace."}
          </p>
          <form className="action-stack" onSubmit={handleLogin} style={{ maxWidth: 360 }}>
            <label className="label">Username</label>
            <input className="input" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} />
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
            />
            <button className="btn" type="submit">
              {authMode === "register" ? "Create account" : "Sign in"}
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setAuthError(null);
                setAuthMode((mode) => (mode === "register" ? "login" : "register"));
              }}
            >
              {authMode === "register" ? "Already have an account? Sign in" : "New here? Create an account"}
            </button>
            {authError ? <p style={{ color: "#fca5a5" }}>{authError}</p> : null}
          </form>
        </div>
      </main>
    );
  }

  if (!workspace) {
    return (
      <main className="app-shell" ref={appShellRef} style={{ gridTemplateColumns: `${sidebarWidth}px 10px 1fr` }}>
        <div className="sidebar" style={{ gridColumn: "1 / span 3", padding: 24 }}>
          <p>Loading workspace…</p>
        </div>
      </main>
    );
  }

  return (
    <main
      className="app-shell"
      ref={appShellRef}
      style={{ gridTemplateColumns: `${sidebarWidth}px 10px 1fr` }}
    >
      <aside className="sidebar">
        <div className="brand-card">
          <h3 className="brand-title">
            <span className="pulse" />
            SchemaStudio
          </h3>
          <p className="subdued">
            {isLightMode
              ? "Running in Light Mode (local, single-user, non-production)."
              : "Craft diagrams, compare branches, and edit schemas. Currently defaults to nomad-simulations."}
          </p>
          <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
            <span className="tag">{loading || diffLoading ? "Working…" : "Ready"}</span>
            {isLightMode ? <span className="tag muted">Single-user</span> : null}
            {schemaVersion ? (
              <span className="tag">Schema {schemaVersion.slice(0, 9)}{schemaSource ? ` (${schemaSource})` : ""}</span>
            ) : (
              <span className="tag muted">Schema version…</span>
            )}
            {selectedClassName ? <span className="tag">Selected: {selectedClassName}</span> : null}
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="label" style={{ marginBottom: 6 }}>
              Appearance
            </div>
            <div className="toggle-group">
              <button
                className={`toggle-chip ${theme === "dark" ? "active" : ""}`}
                onClick={() => setTheme("dark")}
              >
                Dark
              </button>
              <button
                className={`toggle-chip ${theme === "light" ? "active" : ""}`}
                onClick={() => setTheme("light")}
              >
                Light
              </button>
            </div>
          </div>
          {isLightMode ? (
            <div className="row" style={{ marginTop: 12, gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                className="btn secondary"
                type="button"
                onClick={updateSchema}
                disabled={schemaUpdating || !canUpdateSchema}
                title={canUpdateSchema ? undefined : "Desktop builds ship with a bundled schema. Install a newer app release to update it."}
              >
                {schemaUpdating ? "Updating schema…" : canUpdateSchema ? "Update schema" : "Bundled schema"}
              </button>
              {schemaUpdateStatus ? (
                <div className="small" style={{ color: schemaUpdateStatus.startsWith("Update failed") ? "#fca5a5" : "var(--muted)" }}>
                  {schemaUpdateStatus}
                </div>
              ) : !canUpdateSchema ? (
                <div className="small" style={{ color: "var(--muted)" }}>
                  Install a newer desktop release to update the bundled schema.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {!isLightMode && token && userName ? (
          <div className="brand-card">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p className="eyebrow">Signed in</p>
                <h4 style={{ margin: 0 }}>{userName ?? "User"}</h4>
              </div>
              <button className="btn secondary" onClick={logout} type="button">
                Logout
              </button>
            </div>
          </div>
        ) : null}

        <CollapsibleSection
          title="Workspace"
          hint="Explore the data model"
          id="section-workspace"
          open={openWorkspace}
          onToggle={setOpenWorkspace}
        >
          <div className="action-stack">
            <div className="row" style={{ gap: 10 }}>
              <button
                className="btn"
                onClick={() => setMode((m) => (m === "overview" ? "graph" : "overview"))}
                title="Toggle bird's-eye view"
              >
                {mode === "overview" ? "Back to diagram" : "Bird's-eye view"}
              </button>
            </div>
            <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                {isLightMode ? (
                  <>
                    <label className="label">Schema branch</label>
                    <div className="small">{DEFAULT_BRANCH} (fixed in Light Mode)</div>
                  </>
                ) : (
                  <>
                    <label className="label">Choose from branch</label>
                    <select
                      className="select"
                      value={packageBranch}
                      onChange={(e) => handleBranchSelect(e.target.value)}
                    >
                      {[packageBranch || DEFAULT_BRANCH, ...branches.filter((b) => b !== packageBranch)].map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              <button className="btn secondary" onClick={loadPackages} style={{ whiteSpace: "nowrap" }}>
                Refresh packages
              </button>
            </div>

            <div>
              <label className="label">{isLightMode ? "Choose package" : `Choose from ${packageBranch || DEFAULT_BRANCH}`}</label>
              <select
                className="select"
                value={availablePkgs.includes(pkg) ? pkg : ""}
                onChange={(e) => handlePackageSelect(e.target.value)}
              >
                <option value="">Custom package...</option>
                {availablePkgs.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Root section</label>
              <select className="select" value={root} onChange={(e) => setRoot(e.target.value)}>
                {roots.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <div className="small" style={{ marginTop: 4 }}>
                {roots.length ? `${roots.length} sections` : ""}
              </div>
            </div>

            <div className="control-grid" style={{ marginTop: 4 }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={includeQuantities}
                  onChange={(e) => setIncludeQuantities(e.target.checked)}
                />
                Quantities
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={showQuantityMetadata}
                  onChange={(e) => setShowQuantityMetadata(e.target.checked)}
                />
                Show dtypes & shapes
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={includeSubsections}
                  onChange={(e) => setIncludeSubsections(e.target.checked)}
                />
                Subsections
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={includeInheritance}
                  onChange={(e) => setIncludeInheritance(e.target.checked)}
                />
                Inheritance
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={showBaseSections}
                  onChange={(e) => setShowBaseSections(e.target.checked)}
                />
                Show base sections
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={crossModules}
                  onChange={(e) => setCrossModules(e.target.checked)}
                />
                Cross-modules
              </label>
            </div>

            <div className="row" style={{ marginTop: 14, justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <button className="btn" onClick={() => loadGraph()}>
                Build graph
              </button>
              <div className="row" style={{ flex: 1, justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                <input
                  type="file"
                  accept="application/json"
                  ref={importFileRef}
                  style={{ display: "none" }}
                  onChange={handleImportFile}
                />
                <button className="btn secondary" type="button" onClick={handleImportJson}>
                  Import JSON
                </button>
                {currentGraph ? (
                  <>
                    <button className="btn secondary" onClick={exportJson}>
                      Export JSON
                    </button>
                    <button
                      className="btn secondary"
                      onClick={exportPdf}
                      disabled={!graphHandle}
                      title={graphHandle ? "Download current diagram as PDF" : "Build a graph first"}
                    >
                      Export PDF
                    </button>
                  </>
                ) : null}
              </div>
              {importStatus ? (
                <div className="small" style={{ color: importStatus.startsWith("Import failed") ? "#fca5a5" : "var(--muted)", textAlign: "right" }}>
                  {importStatus}
                </div>
              ) : null}
            </div>

            {isLightMode && sendDesignEnabled ? (
              <div className="card" style={{ marginTop: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="row" style={{ alignItems: "center", gap: 8 }}>
                  <strong>Send Design</strong>
                  <span className="tag muted">Share JSON snapshot</span>
                </div>
                <textarea
                  className="input"
                  rows={3}
                  placeholder="Optional note for the team"
                  value={sendNote}
                  onChange={(e) => setSendNote(e.target.value)}
                  style={{ resize: "vertical" }}
                />
                <button className="btn secondary" type="button" onClick={sendDesign} disabled={sending}>
                  {sending ? "Sending…" : "Send design"}
                </button>
                {sendStatus ? (
                  <div className="small" style={{ color: sendStatus.startsWith("Send failed") ? "#fca5a5" : "var(--muted)" }}>
                    {sendStatus}
                  </div>
                ) : null}
              </div>
            ) : null}

            {err ? (
              <p style={{ color: "#fca5a5", marginTop: 10, whiteSpace: "pre-wrap" }}>{err}</p>
            ) : null}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Under the hood"
          hint="Raw schema structure"
          id="section-under"
          open={openUnderTheHood}
          onToggle={setOpenUnderTheHood}
        >
          <UnderTheHoodPanel apiBase={apiBase} token={token} />
        </CollapsibleSection>

        {!isLightMode ? (
          <CollapsibleSection
            title="Compare branches"
            hint="Diff diagrams across git"
            id="section-compare"
            open={openCompare}
            onToggle={setOpenCompare}
          >
            <div className="action-stack">
              <div>
                <label className="label">Base branch</label>
                <select
                  className="select"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                >
                  <option value="">-</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label">Head branch</label>
                <select
                  className="select"
                  value={headBranch}
                  onChange={(e) => setHeadBranch(e.target.value)}
                >
                  <option value="">-</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>

              <button
                className="btn"
                onClick={compareBranches}
                disabled={!baseBranch || !headBranch || diffLoading}
              >
                {diffLoading ? "Comparing…" : "Compare"}
              </button>
            </div>
          </CollapsibleSection>
        ) : null}
      </aside>
      <div
        className="resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
          onMouseDown={startSidebarResize}
        />

      {/* Main workspace: Graph + Doc Panel side-by-side */}
      <div
        className="workspace"
        ref={workspaceRef}
        style={{ gridTemplateColumns: `minmax(0, 1fr) 10px ${docPanelWidth}px` }}
      >
        {/* Persistent help button */}
        <div className="floating-help">
          <details
            open={helpOpen}
            onToggle={(e: SyntheticEvent<HTMLDetailsElement>) => setHelpOpen(e.currentTarget.open)}
          >
            <summary aria-label="Help">❔ Help</summary>
            <div className="help-body">
              <div className="help-close-row">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => setHelpOpen(false)}
                  aria-label="Close help panel"
                >
                  ×
                </button>
              </div>
              <div className="help-grid">
                {helpSummary.map((line, idx) => (
                  <div key={idx}>{line}</div>
                ))}
              </div>
              <div className="help-links">
                <button className="link-button" type="button" onClick={() => focusAndOpen("workspace")}>Workspace</button>
                <button className="link-button" type="button" onClick={() => focusAndOpen("documentation")}>Documentation</button>
                <button className="link-button" type="button" onClick={() => focusAndOpen("audit")}>Audit trail</button>
                {!isLightMode ? (
                  <button className="link-button" type="button" onClick={() => focusAndOpen("compare")}>Compare branches</button>
                ) : null}
                <button className="link-button" type="button" onClick={() => setMode("overview")}>Overview</button>
              </div>
            </div>
          </details>
        </div>

        {/* Left: graph area */}
        <div
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            height: "100vh",
            overflow: mode === "overview" ? "auto" : "hidden",
          }}
        >
          {mode === "overview" ? (
            <div style={{ flex: 1, minHeight: 0 }}>
              <OverviewGrid
                apiBase={apiBase}
                branch={overviewBranch}
                base={normalizedNamespace}
                token={token}
                onClassSelect={handleOverviewClassSelect}
              />
            </div>
          ) : diffData ? (
            <>
              <div className="workspace-toolbar" style={{ justifyContent: "space-between" }}>
                <div className="row" style={{ alignItems: "center" }}>
                  <button className="btn secondary" type="button" onClick={returnToHome}>
                    Back to home
                  </button>
                  <div>
                    Base: {diffData.base.branch} ({diffData.base.sha.slice(0, 7)}) → Head: {diffData.head.branch} ({diffData.head.sha.slice(0, 7)})
                  </div>
                </div>
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <span className="pill diff added">🟩 Added</span>
                  <span className="pill diff changed">🟨 Changed</span>
                  <span className="pill diff removed">🟥 Removed</span>
                </div>
              </div>
              <GraphView
                nodes={diffData.head.graph.nodes}
                edges={diffData.head.graph.edges}
                diff={diffData.diff}
                baseNamespaces={namespaceFilters}
                showBaseSections={showBaseSections}
                pinnedClassIds={pinnedClassIds}
                showQuantityMetadata={showQuantityMetadata}
                showInheritance={includeInheritance}
                theme={theme}
                onReady={setGraphHandle}
              />
            </>
          ) : graph ? (
            <>
              <div style={{ position: "relative", flex: 1 }}>
                <div className="graph-toolbar">
                  <button className="btn secondary" type="button" onClick={returnToHome} style={{ alignSelf: "flex-start" }}>
                    Back to home
                  </button>
                  <div className="label" style={{ marginBottom: 4 }}>Canvas mode</div>
                  <div className="toggle-group">
                    <button
                      className={`toggle-chip ${!editableMode ? "active" : ""}`}
                      type="button"
                      onClick={() => setEditableMode(false)}
                      aria-pressed={!editableMode}
                    >
                      UML
                    </button>
                    <button
                      className={`toggle-chip ${editableMode ? "active" : ""}`}
                      type="button"
                      onClick={() => {
                        setEditableMode(true);
                        setQuantityActionErr(null);
                      }}
                      disabled={!!addBlockedReason}
                      aria-pressed={editableMode}
                      title={addBlockedReason || "Toggle editing"}
                    >
                      Edit
                    </button>
                  </div>
                  {startEmpty ? (
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={resetEmptyCanvas}
                        title="Clear saved custom schema edits for this empty canvas"
                        style={{ padding: "6px 10px", whiteSpace: "nowrap" }}
                      >
                        Reset canvas
                      </button>
                      {canvasStatus ? (
                        <span className="small" style={{ color: canvasStatus.startsWith("Reset failed") ? "#fca5a5" : "var(--muted)" }}>
                          {canvasStatus}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {editableMode && addBlockedReason ? (
                    <div className="small" style={{ color: "var(--muted)" }}>{addBlockedReason}</div>
                  ) : null}
                </div>
                <GraphView
                  nodes={graph.nodes}
                  edges={graph.edges}
                  umlState={umlState}
                  baseNamespaces={namespaceFilters}
                  showBaseSections={showBaseSections}
                  pinnedClassIds={pinnedClassIds}
                  selectedClassId={selectedClassId}
                  showQuantityMetadata={showQuantityMetadata}
                  showInheritance={includeInheritance}
                  theme={theme}
                  onReady={setGraphHandle}
                  onSelectClass={handleCanvasClassSelect}
                  onCreateQuantity={createQuantityOnCanvas}
                  onCreateClass={createClassOnCanvas}
                  creatingQuantityFor={creatingQuantityFor}
                  creatingClass={creatingClass}
                  onClearSelection={handleCanvasClear}
                  editableMode={editableMode}
                />
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 16 }}>
                Build a diagram to get started
              </div>
              <div style={{ lineHeight: 1.5, display: "grid", gap: 10 }}>
                <div>
                  1) Go to <button className="link-button" type="button" onClick={() => focusAndOpen("workspace")}>Workspace 👈</button> and pick a root, then hit “Build graph” to load the nomad-simulations schema.
                </div>
                <div>
                  2) See the <button className="link-button" type="button" onClick={() => focusAndOpen("documentation")}>Documentation 👉</button> panel to read class/quantity details as you browse.
                </div>
                <div>
                  3) Switch to <strong>Editable mode</strong> to add, rename, or remove classes and quantities.
                </div>
                <div>
                  4) Prefer to sketch your own? Turn on “Start from empty canvas” to drop in custom classes/quantities without loading existing schema.
                </div>
                {!isLightMode ? (
                  <div>
                    5) <button className="link-button" type="button" onClick={() => focusAndOpen("compare")}>Compare branches 👈</button> to see how two git branches differ in structure.
                  </div>
                ) : null}
                <div>
                  {isLightMode ? "5)" : "6)"} Communicate your edits via <button className="link-button" type="button" onClick={() => focusAndOpen("audit")}>Audit trail 👉</button> - export or clear the log anytime.
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <button className="btn secondary" type="button" onClick={() => toggleEmptyMode()}>
                  {emptyCanvasActive ? "Back to schema graph" : "+ Start from empty canvas"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize documentation panel"
          onMouseDown={startDocResize}
        />

        {/* Right: Documentation + quantity editing */}
        <div
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            height: "100vh",
            borderLeft: "1px solid var(--panel-border)",
            padding: "10px",
            gap: "10px",
            overflowY: "auto"
          }}
        >
          {/* TOP PANEL — content-stacked like left sidebar */}
          <div
            style={{
              flex: "0 0 auto"
            }}
          >
            <CollapsibleSection
              title="Documentation"
              hint="Browse docs and edit quantities"
              className="panel"
              id="section-documentation"
              open={openDocumentation}
              onToggle={setOpenDocumentation}
            >
              <DocPanel
                editableMode={editableMode}
                onRemoveQuantity={removeQuantity}
                onEditQuantity={editQuantity}
                onEditClass={editClassDoc}
                blockedReason={addBlockedReason}
                actionError={quantityActionErr}
                clearActionError={clearQuantityActionError}
              />
            </CollapsibleSection>
          </div>

          {/* BOTTOM PANEL — content-stacked like left sidebar */}
          <div
            style={{
              flex: "0 0 auto"
            }}
          >
            <CollapsibleSection
              title="Audit trail"
              hint="Track edits and export"
              className="panel"
              id="section-audit"
              open={openAuditTrail}
              onToggle={setOpenAuditTrail}
            >
              <div className="action-stack" style={{ gap: 10 }}>
                <div className="row" style={{ gap: 8 }}>
                  {!isLightMode ? (
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={exportAuditLog}
                      disabled={!auditTrail.length}
                      title={auditTrail.length ? "Download audit log as JSON" : "No edits recorded yet"}
                    >
                      Export audit JSON
                    </button>
                  ) : null}
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={restoreAllArchivedToCurrent}
                    disabled={archivedAuditCount === 0}
                    title="Reactivate archived edits on this canvas"
                  >
                    Restore archived
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={clearAuditTrail}
                    disabled={!auditTrail.length && !(graph?.applied_edits?.length)}
                  >
                    Clear
                  </button>
                </div>
                <div className="small" style={{ color: "var(--muted)" }}>
                  {auditEntriesForCurrentPackage.length
                    ? `${activeAuditCount} active edits${archivedAuditCount > 0 ? ` (${archivedAuditCount} archived)` : ""}`
                    : "No edits on this canvas yet"}
                </div>
                <div
                  style={{
                    maxHeight: 240,
                    overflowY: "auto",
                    border: "1px solid var(--panel-border)",
                    borderRadius: 10,
                    padding: 8,
                    background: "var(--panel)",
                    fontSize: 12
                  }}
                >
                  {[...auditEntriesForCurrentPackage].reverse().map((entry) => {
                    const archived = Boolean(
                      entry.replayable === false ||
                      (entry.package ? normalizePackageName(entry.package) !== currentPackageForAudit : false)
                    );
                    return (
                      <div
                        key={entry.id}
                        style={{
                          padding: "6px 8px",
                          borderBottom: "1px solid var(--panel-border)",
                        }}
                      >
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => undoAuditEntry(entry.id)}
                          disabled={archived}
                          title={archived ? "Archived for a different canvas; undo disabled" : "Undo this change"}
                          style={{ padding: "6px 10px" }}
                        >
                          🗑
                        </button>
                        {archived ? (
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={() => restoreArchivedEntry(entry.id)}
                            style={{ padding: "6px 10px" }}
                            title="Reactivate this edit on the current canvas"
                          >
                            ↺
                          </button>
                        ) : null}
                        <div>
                          <div style={{ fontWeight: 700 }}>
                            {entry.description}
                            {archived ? " (archived)" : ""}
                          </div>
                          <div style={{ color: "var(--muted)" }}>
                            {new Date(entry.timestamp).toLocaleString()}
                          </div>
                          <div style={{ color: "var(--subtitle)" }}>Change: {entry.change.type}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </CollapsibleSection>
          </div>
        </div>
      </div>
    </main>
  );
}
