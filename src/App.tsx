import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  FileSpreadsheet,
  LayoutDashboard,
  LogOut,
  Package,
  Pencil,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
  Warehouse,
  Wrench,
  X,
} from "lucide-react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "@xyflow/react/dist/style.css";
import "./App.css";
import {
  api,
  MODULES,
  MODULE_FIELD_SCHEMAS,
  PRESETS,
  type Assignment,
  type FieldSchema,
  type InventoryItem,
  type ModuleKey,
  type OperationalLog,
  type OpsRequest,
  type Release,
  type Site,
  type SiteMember,
} from "./domain";

type User = { id: string; name: string; email: string; phone?: string; role: string };
const formatCurrency = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
type AuthResponse = { token?: string; user?: User; error?: string };
type FlowNode = Node<
  {
    moduleId: ModuleKey;
    title: string;
    description: string;
    color: string;
    inputs: string[];
    outputs: string[];
    fields: string[];
    config: Record<string, string>;
  },
  "moduleNode"
>;
type View = "hub" | "site" | "builder";
type Modal = "site" | "request" | "item" | "edit-item" | null;

const iconForPage: Record<string, typeof Package> = {
  inventory: Package,
  requests: ClipboardList,
  approvals: CheckCheck,
  assignments: Boxes,
  consumption: Activity,
  returns: ArrowDownToLine,
  analytics: Activity,
  reports: FileSpreadsheet,
  repairs: Wrench,
  overview: LayoutDashboard,
};

function ModuleNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <div
      className={`flow-node${selected ? " is-selected" : ""}`}
      style={{ "--node-color": data.color } as React.CSSProperties}
    >
      {data.inputs.map((input, index) => (
        <Handle
          key={input}
          type="target"
          position={Position.Left}
          id={`in:${input}`}
          style={{ top: `${30 + index * 18}px` }}
        />
      ))}
      <div className="flow-node-top">
        <span className="node-dot" />
        <span>{data.title}</span>
        <span className="node-menu">•••</span>
      </div>
      <p>{data.description}</p>
      <div className="flow-node-foot">
        <span>{data.inputs.length ? data.inputs.join(" / ") : "ENTRY"}</span>
        <ArrowRight size={12} />
        <span>{data.outputs.join(" / ") || "VIEW"}</span>
      </div>
      {data.outputs.map((output, index) => (
        <Handle
          key={output}
          type="source"
          position={Position.Right}
          id={`out:${output}`}
          style={{ top: `${30 + index * 18}px` }}
        />
      ))}
    </div>
  );
}

const nodeTypes = { moduleNode: ModuleNode };

function makeFlow(moduleIds: ModuleKey[]) {
  const definitions = moduleIds
    .map((id) => MODULES.find((module) => module.id === id))
    .filter((item) => item !== undefined);
  const nodes: FlowNode[] = definitions.map((module, index) => ({
    id: `node-${module.id}`,
    type: "moduleNode",
    position: { x: (index % 4) * 270, y: Math.floor(index / 4) * 190 },
    data: {
      moduleId: module.id,
      title: module.name,
      description: module.description,
      color: module.color,
      inputs: module.input,
      outputs: module.output,
      fields: module.fields,
      config: {},
    },
  }));
  const edges: {
    id: string;
    source: string;
    target: string;
    sourceHandle: string;
    targetHandle: string;
    animated: boolean;
    style: { stroke: string; strokeWidth: number };
  }[] = [];
  for (const source of nodes)
    for (const target of nodes) {
      if (source.id === target.id) continue;
      const output = source.data.outputs.find((type) =>
        target.data.inputs.includes(type),
      );
      if (
        output &&
        !edges.some(
          (edge) => edge.source === source.id && edge.target === target.id,
        )
      )
        edges.push({
          id: `${source.id}-${target.id}`,
          source: source.id,
          target: target.id,
          sourceHandle: `out:${output}`,
          targetHandle: `in:${output}`,
          animated: true,
          style: { stroke: "#bd8052", strokeWidth: 2 },
        });
    }
  return { nodes, edges };
}

function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem("opshub-token") ?? "",
  );
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("admin@opshub.local");
  const [password, setPassword] = useState("Demo2026!");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpEnabled, setOtpEnabled] = useState(false);
  const [loginMode, setLoginMode] = useState<"password" | "phone">("password");
  const [loginPortal, setLoginPortal] = useState("admin");
  const [sites, setSites] = useState<Site[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [view, setView] = useState<View>("hub");
  const [activePage, setActivePage] = useState("overview");
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [requests, setRequests] = useState<OpsRequest[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    let retryDelay = 500;
    const loadAuthMethods = async () => {
      try {
        const response = await fetch("/api/auth/methods");
        if (!response.ok) throw new Error("Authentication methods are not ready");
        const methods = await response.json() as { minimothOtp?: boolean };
        if (active) setOtpEnabled(Boolean(methods.minimothOtp));
      } catch {
        if (!active) return;
        retryTimer = window.setTimeout(loadAuthMethods, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
      }
    };
    void loadAuthMethods();
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, []);
  useEffect(() => {
    if (!token) return;
    api<{ user: User; sites: Site[] }>("/session", token)
      .then((data) => {
        setUser(data.user);
        setSites(data.sites);
        if (loginPortal !== "admin") {
          const target = data.sites.find((item) => item.slug === loginPortal);
          if (target) {
            setSite(target);
            setView("site");
            setActivePage("overview");
            Promise.all([
              api<{ inventory: InventoryItem[] }>(`/${target.siteId}/inventory`, token),
              api<{ requests: OpsRequest[] }>(`/${target.siteId}/requests`, token),
              api<{ releases: Release[] }>(`/${target.siteId}/releases`, token),
            ]).then(([stock, requestData, releaseData]) => {
              setInventory(stock.inventory);
              setRequests(requestData.requests);
              setReleases(releaseData.releases);
            }).catch((error: unknown) => setToast(error instanceof Error ? error.message : "Could not load department site"));
          }
        }
      })
      .catch(() => {
        localStorage.removeItem("opshub-token");
        setToken("");
        setUser(null);
      });
  }, [token, loginPortal]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await result.json()) as AuthResponse;
      if (!result.ok || !body.token || !body.user) throw new Error(body.error ?? "Could not sign in");
      establishSession(body);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  function establishSession(body: AuthResponse) {
    if (!body.token || !body.user) throw new Error(body.error ?? "Authentication failed");
    localStorage.setItem("opshub-token", body.token); setUser(body.user); setToken(body.token);
  }
  async function sendPhoneOtp(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const response = await fetch("/api/auth/otp/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not send verification code");
      setOtpSent(true); setToast("Verification code sent by WhatsApp or SMS.");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not send verification code"); }
    finally { setBusy(false); }
  }
  async function verifyPhoneOtp(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const response = await fetch("/api/auth/otp/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, otp }) });
      const body = await response.json() as AuthResponse;
      if (!response.ok) throw new Error(body.error ?? "Could not verify code");
      establishSession(body);
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not verify code"); }
    finally { setBusy(false); }
  }

  async function refreshSites() {
    if (!token) return;
    const result = await api<{ sites: Site[] }>("/sites", token);
    setSites(result.sites);
  }
  async function openSite(nextSite: Site) {
    setSite(nextSite);
    setView("site");
    setActivePage("overview");
    try {
      const [stock, requestData, releaseData] = await Promise.all([
        api<{ inventory: InventoryItem[] }>(`/${nextSite.siteId}/inventory`, token),
        api<{ requests: OpsRequest[] }>(`/${nextSite.siteId}/requests`, token),
        api<{ releases: Release[] }>(`/${nextSite.siteId}/releases`, token),
      ]);
      setInventory(stock.inventory);
      setRequests(requestData.requests);
      setReleases(releaseData.releases);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not load site");
    }
  }
  async function createSite(name: string) {
    try {
      const created = await api<{ site: Site }>("/sites", token, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await refreshSites();
      setModal(null);
      await openSite(created.site);
      setToast(`${name} is ready to configure`);
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "Could not create site",
      );
    }
  }
  async function createRequest(
    title: string,
    quantity: number,
    itemId: string,
    priority: string,
  ) {
    if (!site) return;
    try {
      await api(`/${site.siteId}/requests`, token, {
        method: "POST",
        body: JSON.stringify({ title, quantity, itemId, priority }),
      });
      const result = await api<{ requests: OpsRequest[] }>(
        `/${site.siteId}/requests`,
        token,
      );
      setRequests(result.requests);
      setModal(null);
      setToast(site.slug === "central-stores" ? "Restock request sent to Distribution for approval" : "Request sent to the approval queue");
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "Could not create request",
      );
    }
  }
  async function addItem(values: {
    name: string;
    sku: string;
    quantity: number;
    price: number;
    category: string;
  }) {
    if (!site) return;
    try {
      await api(`/${site.siteId}/inventory`, token, {
        method: "POST",
        body: JSON.stringify(values),
      });
      const result = await api<{ inventory: InventoryItem[] }>(
        `/${site.siteId}/inventory`,
        token,
      );
      setInventory(result.inventory);
      setModal(null);
      setToast("Item added to this site");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not add item");
    }
  }
  async function updateItem(itemId: string, values: { name: string; sku: string; quantity: number; price: number; category: string }) {
    if (!site) return;
    try {
      await api(`/${site.siteId}/inventory/${itemId}`, token, { method: "PATCH", body: JSON.stringify(values) });
      const result = await api<{ inventory: InventoryItem[] }>(`/${site.siteId}/inventory`, token);
      setInventory(result.inventory); setModal(null); setEditingItem(null); setToast("Inventory item updated");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not update item"); }
  }
  async function deleteItem(itemId: string) {
    if (!site || !window.confirm("Delete this inventory item? Referenced items cannot be deleted.")) return;
    try {
      await api(`/${site.siteId}/inventory/${itemId}`, token, { method: "DELETE" });
      setInventory((current) => current.filter((item) => item.id !== itemId)); setToast("Inventory item deleted");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not delete item"); }
  }
  async function approve(requestId: string) {
    if (!site) return;
    try {
      await api(`/${site.siteId}/approvals`, token, {
        method: "POST",
        body: JSON.stringify({ requestId, decision: "approve" }),
      });
      const [requestData, stock] = await Promise.all([
        api<{ requests: OpsRequest[] }>(`/${site.siteId}/requests`, token),
        api<{ inventory: InventoryItem[] }>(`/${site.siteId}/inventory`, token),
      ]);
      setRequests(requestData.requests);
      setInventory(stock.inventory);
      setToast("Approved and issued. Stock was updated in one transaction.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Approval failed");
    }
  }
  async function exportExcel() {
    if (!site) return;
    try {
      const response = await fetch(`/api/${site.siteId}/reports/export.xlsx`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("Export is restricted or unavailable");
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${site.slug}-operations.xlsx`;
      link.click();
      URL.revokeObjectURL(link.href);
      setToast("Workbook downloaded");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Export failed");
    }
  }

  if (!token || !user)
    return (
      <Login
        email={email}
        password={password}
        busy={busy}
        toast={toast}
        phone={phone}
        otp={otp}
        otpSent={otpSent}
        otpEnabled={otpEnabled}
        loginMode={loginMode}
        portal={loginPortal}
        onPortal={(selected) => {
          setLoginPortal(selected);
          const demoEmails: Record<string, string> = {
            "central-stores": "stores@opshub.local",
            "service-centre": "service@opshub.local",
            distribution: "distribution@opshub.local",
            admin: "admin@opshub.local",
          };
          setEmail(demoEmails[selected] ?? "admin@opshub.local");
          setPassword("Demo2026!");
        }}
        onEmail={setEmail}
        onPassword={setPassword}
        onSubmit={signIn}
        onPhone={(value) => { setPhone(value); setOtpSent(false); setOtp(""); }}
        onOtp={setOtp}
        onMode={setLoginMode}
        onResetOtp={() => { setOtpSent(false); setOtp(""); }}
        onSendOtp={sendPhoneOtp}
        onVerifyOtp={verifyPhoneOtp}
      />
    );
  const themedStyle = site
    ? ({
        "--accent": site.theme.accent,
        "--site-canvas": site.theme.canvas,
        "--site-ink": site.theme.ink,
      } as React.CSSProperties)
    : undefined;
  const visibleSites = sites.filter((item) =>
    `${item.name} ${item.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const isAdmin = user.role === "Admin";
  return (
    <div className={`app-shell${isAdmin ? "" : " employee-shell"}`} style={themedStyle}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </div>
          <span>
            opshub<span className="brand-light"> one</span>
          </span>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        {isAdmin && <button
          className={`nav-item${view === "hub" ? " active" : ""}`}
          onClick={() => {
            setView("hub");
            setSite(null);
          }}
        >
          <LayoutDashboard size={17} />
          Hub overview
        </button>}
        <div className="site-nav-title">
              <span>{isAdmin ? "YOUR SITES" : "YOUR DEPARTMENT"}</span>
          {isAdmin && <button
            className="icon-button tiny"
            title="Create a site"
            onClick={() => setModal("site")}
          >
            <Plus size={15} />
          </button>}
        </div>
        <div className="site-nav-list">
          {sites.map((item) => (
            <button
              key={item.siteId}
              className={`site-nav-item${site?.siteId === item.siteId && view !== "hub" ? " active" : ""}`}
              onClick={() => void openSite(item)}
            >
              <span
                className="site-dot"
                style={{ background: item.theme.accent }}
              />
              {item.name}
              <span className="site-nav-count">{item.modules.length}</span>
            </button>
          ))}
        </div>
        {site && view !== "hub" && (
          <>
            <div className="site-nav-title">
              <span>WORKSPACE</span>
            </div>
            {isAdmin && <button
              className={`nav-item${view === "builder" ? " active" : ""}`}
              onClick={() => setView("builder")}
            >
              <Settings2 size={17} />
              Site builder<span className="nav-beta">EDIT</span>
            </button>}
            {isAdmin && site.role &&
              ["Admin"].includes(site.role) &&
              site.modules.includes("users") && (
                <button
                  className={`nav-item${activePage === "users" && view === "site" ? " active" : ""}`}
                  onClick={() => {
                    setView("site");
                    setActivePage("users");
                  }}
                >
                  <Users size={17} />
                  Team & access
                </button>
              )}
            <div className="site-nav-title">
              <span>SITE MODULES</span>
            </div>
            {isAdmin && <button
              className={`nav-item${activePage === "overview" && view === "site" ? " active" : ""}`}
              onClick={() => {
                setView("site");
                setActivePage("overview");
              }}
            >
              <LayoutDashboard size={17} />
              Overview
            </button>}
            {site.pages.map((page) => {
              const PageIcon = iconForPage[page.id] ?? Boxes;
              return (
                <button
                  key={page.id}
                  className={`nav-item${activePage === page.id && view === "site" ? " active" : ""}`}
                  onClick={() => {
                    setView("site");
                    setActivePage(page.id);
                  }}
                >
                  <PageIcon size={17} />
                  {page.label}
                </button>
              );
            })}
          </>
        )}
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            onClick={() => setToast("Help center: support@opshub.local")}
          >
            <CircleHelp size={17} />
            Help center
          </button>
          <div className="profile">
            <div className="avatar">
              {user.name
                .split(" ")
                .map((part) => part[0])
                .join("")
                .slice(0, 2)}
            </div>
            <div className="profile-copy">
              <strong>{user.name}</strong>
              <span>{user.role}</span>
            </div>
            <button
              className="icon-button"
              title="Sign out"
              onClick={() => {
                localStorage.removeItem("opshub-token");
                setToken("");
                setUser(null);
                setSite(null);
                setView("hub");
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>OpsHub</span>
            <span className="crumb-slash">/</span>
            <strong>{view === "hub" ? "All sites" : site?.name}</strong>
            {view === "builder" && (
              <>
                <span className="crumb-slash">/</span>
                <strong>Builder</strong>
              </>
            )}
          </div>
          <div className="topbar-actions">
            <select
              className="mobile-site-switch"
              aria-label="Switch site"
              value={site?.siteId ?? ""}
              onChange={(event) => {
                const nextSite = sites.find((item) => item.siteId === event.target.value);
                if (nextSite) void openSite(nextSite);
                else { setSite(null); setView("hub"); }
              }}
            >
              <option value="">Switch site</option>
              {sites.map((item) => <option key={item.siteId} value={item.siteId}>{item.name}</option>)}
            </select>
            {site && view !== "hub" && (
              <select
                className="mobile-page-switch"
                aria-label="Switch site page"
                value={view === "builder" ? "builder" : activePage}
                onChange={(event) => {
                  if (event.target.value === "builder") setView("builder");
                  else { setView("site"); setActivePage(event.target.value); }
                }}
              >
                <option value="overview">Overview</option>
                <option value="builder">Site builder</option>
                {site.role && ["Manager", "Admin"].includes(site.role) && site.modules.includes("users") && <option value="users">Team & access</option>}
                {site.pages.map((page) => <option key={page.id} value={page.id}>{page.label}</option>)}
              </select>
            )}
            <label className="search-box">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={isAdmin ? "Search sites, items..." : "Search your department..."}
              />
            </label>
            <button
              className="icon-button help-top"
              title="Help"
              onClick={() => setToast("OpsHub support is ready to help.")}
            >
              <CircleHelp size={17} />
            </button>
            <div className="top-avatar">
              {user.name
                .split(" ")
                .map((part) => part[0])
                .join("")
                .slice(0, 2)}
            </div>
          </div>
        </header>
        <div className="page-content">
          {view === "hub" && isAdmin && (
            <Hub
              sites={visibleSites}
              onOpen={(item) => void openSite(item)}
              onCreate={() => setModal("site")}
            />
          )}
          {view === "site" && site && (
            <SiteWorkspace
              site={site}
              page={activePage}
              inventory={inventory}
              requests={requests}
              role={site.role}
              isAdmin={isAdmin}
              onPage={setActivePage}
              onCreateRequest={() => setModal("request")}
              onAddItem={() => setModal("item")}
              onEditItem={(item) => { setEditingItem(item); setModal("edit-item"); }}
              onDeleteItem={(id) => void deleteItem(id)}
              onApprove={(id) => void approve(id)}
              onExport={() => void exportExcel()}
            />
          )}
          {view === "builder" && isAdmin && site && (
            <Builder
              site={site}
              token={token}
              onBack={() => setView("site")}
              onPublished={async () => {
                await refreshSites();
                const updated = (
                  await api<{ sites: Site[] }>("/sites", token)
                ).sites.find((item) => item.siteId === site.siteId);
                if (updated) setSite(updated);
                const data = await api<{ releases: Release[] }>(
                  `/${site.siteId}/releases`,
                  token,
                );
                setReleases(data.releases);
                setToast("Configuration published");
              }}
              releases={releases}
              onRollback={async (releaseId) => {
                await api(
                  `/${site.siteId}/releases/${releaseId}/rollback`,
                  token,
                  { method: "POST" },
                );
                await refreshSites();
                const data = await api<{ releases: Release[] }>(
                  `/${site.siteId}/releases`,
                  token,
                );
                setReleases(data.releases);
                setToast("Site restored to the selected release");
              }}
            />
          )}
        </div>
      </main>
      {modal && (
        <ModalForm
          type={modal}
          inventory={inventory}
          initialItem={editingItem ?? undefined}
          onClose={() => { setModal(null); setEditingItem(null); }}
          onSite={createSite}
          onRequest={createRequest}
          onItem={addItem}
          onUpdateItem={updateItem}
        />
      )}
      {toast && (
        <div className="toast">
          <Check size={16} />
          {toast}
          <button className="icon-button" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function Login({
  email,
  password,
  busy,
  toast,
  phone,
  otp,
  otpSent,
  otpEnabled,
  loginMode,
  portal,
  onPortal,
  onEmail,
  onPassword,
  onSubmit,
  onPhone,
  onOtp,
  onMode,
  onResetOtp,
  onSendOtp,
  onVerifyOtp,
}: {
  email: string;
  password: string;
  busy: boolean;
  toast: string;
  phone: string;
  otp: string;
  otpSent: boolean;
  otpEnabled: boolean;
  loginMode: "password" | "phone";
  portal: string;
  onPortal: (portal: string) => void;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onPhone: (value: string) => void;
  onOtp: (value: string) => void;
  onMode: (mode: "password" | "phone") => void;
  onResetOtp: () => void;
  onSendOtp: (event: React.FormEvent) => void;
  onVerifyOtp: (event: React.FormEvent) => void;
}) {
  const portals = [
    { id: "central-stores", label: "Central Stores", detail: "Stock & deliveries", icon: Warehouse },
    { id: "service-centre", label: "Service Centre", detail: "Repairs & requests", icon: ClipboardCheck },
    { id: "distribution", label: "Distribution", detail: "Field operations", icon: Boxes },
    { id: "admin", label: "Admin Login", detail: "Manage all sites", icon: ShieldCheck },
  ];
  return (
    <div className="login-screen">
      <div className="login-aside">
        <div className="brand brand-inverse">
          <div className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </div>
          <span>
            opshub<span className="brand-light"> one</span>
          </span>
        </div>
        <div className="login-art">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-center">
            <div className="brand-mark large">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className="art-chip chip-top">
            <Warehouse size={17} /> Central Stores{" "}
            <span className="chip-live" />
          </div>
          <div className="art-chip chip-right">
            <ClipboardCheck size={17} /> Service Centre
          </div>
          <div className="art-chip chip-bottom">
            <Boxes size={17} /> Distribution
          </div>
        </div>
        <div className="login-aside-copy">
          <div className="eyebrow light">ONE HUB · MANY OPERATIONS</div>
          <h1>
            Different teams.
            <br />
            One clear view.
          </h1>
          <p>
            Bring every operation into focus, without asking every team to work
            the same way.
          </p>
        </div>
        <div className="aside-foot">
          <span>OPS SYSTEMS / 01</span>
          <span>BUILT FOR THE WAY WORK MOVES</span>
        </div>
      </div>
      <div className="login-main">
        <div className="login-form-wrap">
          <div className="eyebrow">YOUR OPERATIONS, CONNECTED</div>
          <h2>Welcome back</h2>
          <p className="muted">Choose your workspace to continue.</p>
          <div className="portal-options" role="group" aria-label="Choose a workspace">
            {portals.map(({ id, label, detail, icon: Icon }) => (
              <button key={id} type="button" className={`portal-option${portal === id ? " selected" : ""}`} aria-pressed={portal === id} onClick={() => onPortal(id)}>
                <span className="portal-icon"><Icon size={17} /></span>
                <span className="portal-copy"><strong>{label}</strong><small>{detail}</small></span>
                {portal === id && <span className="portal-indicator" aria-hidden="true" />}
              </button>
            ))}
          </div>
          <p className="portal-note">{portal === "admin" ? "Administrator access includes the hub overview and site management." : "Employee access is limited to the tools and information for your department."}</p>
          {otpEnabled && <div className="login-mode" role="group" aria-label="Sign-in method"><button type="button" className={loginMode === "password" ? "selected" : ""} onClick={() => onMode("password")}>Password</button><button type="button" className={loginMode === "phone" ? "selected" : ""} onClick={() => onMode("phone")}>Phone OTP</button></div>}
          {loginMode === "password" || !otpEnabled ? <form onSubmit={onSubmit}>
            <label>
              Email address
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => onEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => onPassword(event.target.value)}
                required
              />
            </label>
            <button
              className="button button-primary sign-in-button"
              disabled={busy}
            >
              {busy ? (
                "Signing in..."
              ) : (
                <>
                  Sign in <ArrowRight size={16} />
                </>
              )}
            </button>
          </form> : <form onSubmit={otpSent ? onVerifyOtp : onSendOtp}>
            <label>Phone number<input type="tel" autoComplete="tel" placeholder="+919876543210" value={phone} onChange={(event) => onPhone(event.target.value)} pattern="\+[1-9][0-9]{7,14}" title="Use international E.164 format, e.g. +919876543210" required /></label>
            {otpSent && <label>6-digit code<input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={otp} onChange={(event) => onOtp(event.target.value)} required autoFocus /></label>}
            <button className="button button-primary sign-in-button" disabled={busy}>{busy ? "Working..." : otpSent ? <>Verify code <ArrowRight size={16} /></> : <>Send OTP <ArrowRight size={16} /></>}</button>
            {otpSent && <button className="text-button otp-resend" type="button" onClick={onResetOtp}>Use a different number</button>}
          </form>}
          {toast && <div className="login-feedback" role="status">{toast}</div>}
          {loginMode === "password" && <div className="demo-hint">
            <Sparkles size={15} />
            <span>Seeded demo account</span>
            <code>{email}</code>
            <code>{password}</code>
          </div>}
          <div className="login-foot">
            <ShieldCheck size={15} />
            Secure access · scoped permissions · isolated sites
          </div>
        </div>
      </div>
    </div>
  );
}

function Hub({
  sites,
  onOpen,
  onCreate,
}: {
  sites: Site[];
  onOpen: (site: Site) => void;
  onCreate: () => void;
}) {
  const totalStock = sites.reduce(
    (sum, item) => sum + item.metrics.stockValue,
    0,
  );
  const openRequests = sites.reduce(
    (sum, item) => sum + item.metrics.openRequests,
    0,
  );
  return (
    <>
      <section className="hub-intro">
        <div>
          <div className="eyebrow">
            OPERATIONS PORTFOLIO <span className="live-indicator" />
          </div>
          <h1>
            Every site, <em>in sync.</em>
          </h1>
          <p>
            A live view across the teams, tools and workflows that keep your
            operation moving.
          </p>
        </div>
        <button className="button button-primary" onClick={onCreate}>
          <Plus size={16} />
          New site
        </button>
      </section>
      <section className="metric-strip">
        <Metric
          label="ACTIVE SITES"
          value={String(sites.length).padStart(2, "0")}
          detail="All systems operational"
          tone="green"
        />
        <Metric
          label="OPEN REQUESTS"
          value={String(openRequests).padStart(2, "0")}
          detail="Across all operations"
          tone="orange"
        />
        <Metric
          label="STOCK VALUE"
          value={formatCurrency(totalStock)}
          detail="Combined site inventory"
          tone="blue"
        />
        <Metric
          label="PUBLISHED BUILDS"
          value={String(
            sites.reduce((sum, item) => sum + item.release, 0),
          ).padStart(2, "0")}
          detail="Versioned and recoverable"
          tone="neutral"
        />
      </section>
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR OPERATING UNITS</span>
          <h2>
            Sites <span className="count-pill">{sites.length}</span>
          </h2>
        </div>
        <div className="heading-tools">
          <span className="status-key">
            <i />
            Live
          </span>
          <button className="text-button" onClick={onCreate}>
            Manage sites <ArrowRight size={14} />
          </button>
        </div>
      </div>
      <section className="site-grid">
        {sites.map((item, index) => (
          <SiteCard
            key={item.siteId}
            site={item}
            index={index}
            onOpen={() => onOpen(item)}
          />
        ))}
        <button className="site-create-card" onClick={onCreate}>
          <span className="create-symbol">
            <Plus size={21} />
          </span>
          <strong>Bring another team in</strong>
          <span>New site, same foundation</span>
          <span className="create-arrow">
            <ArrowRight size={16} />
          </span>
        </button>
      </section>
      <section className="hub-bottom">
        <div className="system-note">
          <div className="note-icon">
            <ShieldCheck size={19} />
          </div>
          <div>
            <strong>One foundation. Separate boundaries.</strong>
            <span>
              Every site keeps its own data, roles and release history.
            </span>
          </div>
          <span className="secure-label">ISOLATION ACTIVE</span>
        </div>
        <div className="hub-version">
          OPS / HUB <b>v1.4.2</b>
          <span>·</span> Last sync just now
        </div>
      </section>
    </>
  );
}

function SiteCard({
  site,
  index,
  onOpen,
}: {
  site: Site;
  index: number;
  onOpen: () => void;
}) {
  const initials = site.name
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 3);
  return (
    <article
      className={`site-card card-enter delay-${index + 1}`}
      style={{ "--site-accent": site.theme.accent } as React.CSSProperties}
    >
      <div className="site-card-head">
        <div className="site-monogram">{initials}</div>
        <span className="site-status">
          <i />
          {site.status}
        </span>
        <button className="icon-button" title="Open site" onClick={onOpen}>
          <ArrowRight size={16} />
        </button>
      </div>
      <div className="site-card-copy">
        <span className="site-slug">/{site.slug}</span>
        <h3>{site.name}</h3>
        <p>{site.description}</p>
      </div>
      <div className="site-card-metrics">
        <div>
          <strong>{site.metrics.openRequests}</strong>
          <span>Open requests</span>
        </div>
        <div>
          <strong>{site.metrics.lowStock}</strong>
          <span>Low stock</span>
        </div>
        <div>
          <strong>{site.modules.length}</strong>
          <span>Modules</span>
        </div>
      </div>
      <div className="site-card-foot">
        <div className="module-stack">
          {site.modules.slice(0, 5).map((moduleId) => (
            <span
              key={moduleId}
              title={MODULES.find((item) => item.id === moduleId)?.name}
              style={{
                backgroundColor: MODULES.find((item) => item.id === moduleId)
                  ?.color,
              }}
            />
          ))}
          {site.modules.length > 5 && <small>+{site.modules.length - 5}</small>}
        </div>
        <button className="open-site-button" onClick={onOpen}>
          Open site <ArrowRight size={14} />
        </button>
      </div>
    </article>
  );
}

function SiteWorkspace({
  site,
  page,
  inventory,
  requests,
  role,
  isAdmin,
  onPage,
  onCreateRequest,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onApprove,
  onExport,
}: {
  site: Site;
  page: string;
  inventory: InventoryItem[];
  requests: OpsRequest[];
  role?: Site["role"];
  isAdmin: boolean;
  onPage: (page: string) => void;
  onCreateRequest: () => void;
  onAddItem: () => void;
  onEditItem: (item: InventoryItem) => void;
  onDeleteItem: (id: string) => void;
  onApprove: (id: string) => void;
  onExport: () => void;
}) {
  const pending = requests.filter((item) => item.status === "Pending approval");
  const lowStock = inventory.filter((item) => item.quantity <= item.reorderAt);
  const chartData = inventory
    .slice(0, 6)
    .map((item) => ({
      name: item.name.split(" ")[0],
      available: item.quantity,
      reorder: item.reorderAt,
    }));
  const pageTitle =
    site.pages.find((item) => item.id === page)?.label ?? "Overview";
  const [inventorySearch, setInventorySearch] = useState("");
  const visibleInventory = inventory.filter((item) => `${item.name} ${item.sku} ${item.category} ${item.location}`.toLowerCase().includes(inventorySearch.toLowerCase()));
  if (page === "inventory")
    return (
      <>
        <PageHeader
          eyebrow={`${site.name.toUpperCase()} / INVENTORY`}
          title={isAdmin ? "Stock ledger" : site.slug === "central-stores" ? "Store inventory" : "Products & service parts"}
          description={isAdmin ? "A site-scoped view of what's on hand, where it lives and what needs attention." : "Check product availability, store locations and items that need replenishing."}
          action={
            (role === "Manager" || role === "Admin") ?
            <button className="button button-primary" onClick={onAddItem}>
              <Plus size={16} />
              Add item
            </button> : undefined
          }
        />
        <div className="table-toolbar">
          <span>{inventory.length} products and service parts</span>
          <span className="table-filter">
            <Search size={14} />
            <input aria-label="Filter inventory" value={inventorySearch} onChange={(event) => setInventorySearch(event.target.value)} placeholder="Filter inventory" />
          </span>
        </div>
        <InventoryTable inventory={visibleInventory} canManage={role === "Manager" || role === "Admin"} onEdit={onEditItem} onDelete={onDeleteItem} />
      </>
    );
  if (page === "requests" || page === "approvals")
    return (
      <>
        <PageHeader
          eyebrow={`${site.name.toUpperCase()} / WORKFLOW`}
          title={isAdmin ? pageTitle : page === "approvals" ? "Needs your review" : "Requests & updates"}
          description={
            !isAdmin && page === "requests"
              ? "Follow your requests from submission through approval and fulfilment."
              : !isAdmin && page === "approvals"
                ? "Review department requests and keep work moving."
                : page === "approvals"
              ? "Review store and service requests, then prepare approved products for dispatch."
              : "Follow a store transfer or service request from submission to fulfilment."
          }
          action={
            page === "requests" ? (
              <button
                className="button button-primary"
                onClick={onCreateRequest}
              >
                <Plus size={16} />
                New request
              </button>
            ) : undefined
          }
        />
        {page === "approvals" && (
          <div className="notice-band">
            <ShieldCheck size={17} />
            <span>
              Approval and stock issue run in a single database transaction.
            </span>
            <span className="notice-tag">TRANSACTIONAL</span>
          </div>
        )}
        <RequestList
          requests={requests}
          approvals={page === "approvals"}
          onApprove={onApprove}
        />
      </>
    );
  if (page === "assignments" || page === "consumption" || page === "returns")
    return (
      <AssignmentPanel
        site={site}
        initialMode={
          page === "consumption"
            ? "consumption"
            : page === "returns"
              ? "return"
              : null
        }
      />
    );
  if (page === "repairs") return <RepairPanel site={site} requests={requests} />;
  if (page === "analytics")
    return (
      <>
        <PageHeader
          eyebrow={`${site.name.toUpperCase()} / INSIGHTS`}
          title="Operations at a glance"
          description="Site-level stock health and request throughput."
        />
        <Analytics
          inventory={inventory}
          requests={requests}
          chartData={chartData}
        />
      </>
    );
  if (page === "users") return <UsersPanel site={site} />;
  if (page === "reports")
    return (
      <>
        <PageHeader
          eyebrow={`${site.name.toUpperCase()} / REPORTS`}
          title="Reports & exports"
          description="Import or export a workbook for this site. Access is checked by role."
          action={
            <div className="report-actions">
              <ExcelImportButton siteId={site.siteId} />
              <button className="button button-primary" onClick={onExport}>
                <ArrowDownToLine size={16} />
                Export Excel
              </button>
            </div>
          }
        />
        <div className="report-panel">
          <div className="report-icon">
            <FileSpreadsheet size={22} />
          </div>
          <div>
            <strong>{site.name} operations workbook</strong>
            <span>Inventory · requests · assignments · generated now</span>
          </div>
          <span className="report-access">MANAGER+</span>
          <button className="button button-outline" onClick={onExport}>
            <ArrowDownToLine size={15} />
            Download
          </button>
        </div>
        <div className="report-note">
          <ShieldCheck size={16} />
          Only authorized Managers and Admins can import or export site data.
          Every workbook is filtered by site.
        </div>
      </>
    );
  return (
    <>
      <section className="site-welcome">
        <div className="welcome-copy">
          <div className="eyebrow">
            <span className="live-indicator" />
            LIVE SITE / {site.slug.toUpperCase()}
          </div>
          <h1>
            {site.name}
            <span className="welcome-period">.</span>
          </h1>
          <p>{site.description}</p>
          <div className="welcome-actions">
            <button
              className="button button-primary"
              onClick={() => onPage("inventory")}
            >
              <Package size={16} />
              View inventory
            </button>
            <button className="button button-light" onClick={onCreateRequest}>
              <Plus size={16} />
              Create request
            </button>
          </div>
        </div>
        <div className="welcome-graphic">
          <div className="graphic-ring ring-a" />
          <div className="graphic-ring ring-b" />
          <div className="graphic-core">
            <Warehouse size={28} />
          </div>
          <span className="graphic-label label-a">
            {site.modules.length} ACTIVE MODULES
          </span>
          <span className="graphic-label label-b">
            V{site.release}.0 · LIVE
          </span>
        </div>
      </section>
      <section className="site-kpis">
        <Metric
          label="STOCK VALUE"
          value={formatCurrency(site.metrics.stockValue)}
          detail={`${inventory.length} active items`}
          tone="green"
        />
        <Metric
          label="OPEN REQUESTS"
          value={String(pending.length).padStart(2, "0")}
          detail="Awaiting a decision"
          tone="orange"
        />
        <Metric
          label="LOW STOCK"
          value={String(lowStock.length).padStart(2, "0")}
          detail="At or below reorder point"
          tone="blue"
        />
        <Metric
          label="COMPLETED"
          value={String(site.metrics.completed).padStart(2, "0")}
          detail="This month"
          tone="neutral"
        />
      </section>
      <div className="workspace-grid">
        <section className="panel stock-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">STOCK HEALTH</span>
              <h2>On hand vs reorder point</h2>
            </div>
            <button className="text-button" onClick={() => onPage("inventory")}>
              Full ledger <ArrowRight size={14} />
            </button>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                barGap={3}
                margin={{ top: 8, right: 4, left: -25, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 5"
                  vertical={false}
                  stroke="#e9e8e1"
                />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#7d827d", fontSize: 11 }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#7d827d", fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ fill: "#f3f1eb" }}
                  contentStyle={{
                    border: "1px solid #e5e4dc",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="available" radius={[3, 3, 0, 0]} barSize={16}>
                  {chartData.map((entry, index) => (
                    <Cell
                      key={entry.name}
                      fill={
                        entry.available <= entry.reorder
                          ? "#cc7554"
                          : site.theme.accent
                      }
                      opacity={index === 0 ? 1 : 0.78}
                    />
                  ))}
                </Bar>
                <Bar
                  dataKey="reorder"
                  fill="#d8d8cf"
                  radius={[3, 3, 0, 0]}
                  barSize={16}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-accent" />
              Available
            </span>
            <span>
              <i className="legend-reorder" />
              Reorder point
            </span>
          </div>
        </section>
        <section className="panel queue-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">NEEDS YOUR EYES</span>
              <h2>
                Approval queue{" "}
                <span className="count-pill">{pending.length}</span>
              </h2>
            </div>
            <button
              className="icon-button"
              title="Open approvals"
              onClick={() => onPage("approvals")}
            >
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="queue-list">
            {pending.slice(0, 4).map((request) => (
              <div className="queue-item" key={request.id}>
                <div
                  className={`queue-symbol ${request.priority === "Urgent" ? "urgent" : ""}`}
                >
                  <ClipboardList size={16} />
                </div>
                <div className="queue-copy">
                  <strong>{request.title}</strong>
                  <span>
                    {request.requester} · {request.quantity} ×{" "}
                    {request.itemName}
                  </span>
                </div>
                <button
                  className="queue-open"
                  onClick={() => onPage("approvals")}
                  aria-label={`Review ${request.title}`}
                >
                  <ArrowRight size={15} />
                </button>
              </div>
            ))}
            {pending.length === 0 && (
              <div className="empty-queue">
                <CheckCheck size={20} />
                <span>All clear. No approvals waiting.</span>
              </div>
            )}
          </div>
          <button className="queue-footer" onClick={() => onPage("approvals")}>
            Open approval queue <ArrowRight size={14} />
          </button>
        </section>
      </div>
      <section className="site-footerline">
        <div>
          <span className="footer-pulse" />
          <strong>{site.status} configuration</strong>
          <span>
            Version {site.release}.0 · Updated{" "}
            {new Date(site.updatedAt).toLocaleDateString()}
          </span>
        </div>
        <button className="text-button" onClick={() => onPage("reports")}>
          Open reports <ArrowRight size={14} />
        </button>
      </section>
    </>
  );
}

function Builder({
  site,
  token,
  onBack,
  onPublished,
  releases,
  onRollback,
}: {
  site: Site;
  token: string;
  onBack: () => void;
  onPublished: () => void;
  releases: Release[];
  onRollback: (id: string) => Promise<void>;
}) {
  const initial = makeFlow(site.modules);
  const nodeSequence = useRef(0);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(
    initial.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selected, setSelected] = useState<FlowNode | null>(null);
  const [saving, setSaving] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ config?: { nodes?: FlowNode[]; edges?: typeof edges } }>(
      `/${site.siteId}/components`,
      token,
    )
      .then((data) => {
        if (alive && data.config?.nodes?.length) {
          setNodes(data.config.nodes);
          setEdges(data.config.edges ?? []);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [site.siteId, token, setEdges, setNodes]);
  const validConnection = (connection: Connection) => {
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    const output = connection.sourceHandle?.replace("out:", "");
    const input = connection.targetHandle?.replace("in:", "");
    return Boolean(
      source &&
      target &&
      output &&
      input &&
      output === input &&
      source.data.outputs.includes(output) &&
      target.data.inputs.includes(input),
    );
  };
  function addModule(moduleId: ModuleKey) {
    const module = MODULES.find((item) => item.id === moduleId);
    if (!module) return;
    setNodes((current) => {
      let id = `node-${module.id}-${nodeSequence.current++}`;
      while (current.some((node) => node.id === id)) {
        id = `node-${module.id}-${nodeSequence.current++}`;
      }
      return [
        ...current,
        {
          id,
          type: "moduleNode",
          position: {
            x: 130 + (current.length % 3) * 260,
            y: 80 + Math.floor(current.length / 3) * 170,
          },
          data: {
            moduleId,
            title: module.name,
            description: module.description,
            color: module.color,
            inputs: module.input,
            outputs: module.output,
            fields: module.fields,
            config: {},
          },
        },
      ];
    });
  }
  function applyPreset(modules: ModuleKey[]) {
    const flow = makeFlow(modules);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelected(null);
  }
  async function saveAndPublish() {
    setSaving(true);
    setMessage("");
    try {
      await api(`/${site.siteId}/components`, token, {
        method: "POST",
        body: JSON.stringify({
          nodes,
          edges,
          modules: [...new Set(nodes.map((node) => node.data.moduleId))],
        }),
      });
      await api(`/${site.siteId}/releases`, token, {
        method: "POST",
        body: JSON.stringify({
          status: "Published",
          label: "Published from visual builder",
        }),
      });
      onPublished();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not publish configuration",
      );
    } finally {
      setSaving(false);
    }
  }
  function updateConfig(field: string, value: string) {
    if (!selected) return;
    const config = { ...selected.data.config, [field]: value };
    setNodes((current) =>
      current.map((node) =>
        node.id === selected.id
          ? { ...node, data: { ...node.data, config } }
          : node,
      ),
    );
    setSelected({ ...selected, data: { ...selected.data, config } });
  }
  const filteredModules = MODULES.filter((module) =>
    module.name.toLowerCase().includes(paletteSearch.toLowerCase()),
  );
  return (
    <div className="builder-page">
      <div className="builder-header">
        <div>
          <button className="back-link" onClick={onBack}>
            <ArrowLeft size={14} />
            {site.name}
          </button>
          <div className="builder-title-row">
            <h1>Site builder</h1>
            <span className="draft-pill">DRAFT</span>
          </div>
          <p>
            Arrange modules and define how information moves across this site.
          </p>
        </div>
        <div className="builder-actions">
          <button
            className="button button-outline"
            onClick={() => setPreview(true)}
          >
            Preview
          </button>
          <button
            className="button button-primary"
            onClick={() => void saveAndPublish()}
            disabled={saving}
          >
            <Check size={15} />
            {saving ? "Publishing..." : "Publish changes"}
          </button>
        </div>
      </div>
      {message && (
        <div className="builder-message">
          {message}
          <button className="icon-button" onClick={() => setMessage("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {preview && <BuilderPreview site={site} nodes={nodes} onClose={() => setPreview(false)} />}
      <div className="builder-layout">
        <aside className="builder-palette">
          <div className="palette-heading">
            <span className="eyebrow">MODULE PALETTE</span>
            <span className="module-count">{MODULES.length}</span>
          </div>
          <label className="palette-search">
            <Search size={14} />
            <input
              value={paletteSearch}
              onChange={(event) => setPaletteSearch(event.target.value)}
              placeholder="Find a module"
            />
          </label>
          <div className="preset-block">
            <span className="palette-label">START WITH A PRESET</span>
            {PRESETS.map((preset) => (
              <button
                className="preset-button"
                key={preset.id}
                onClick={() => applyPreset(preset.modules)}
              >
                <span>
                  <strong>{preset.name}</strong>
                  <small>{preset.description}</small>
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
          <div className="palette-module-list">
            <span className="palette-label">APPROVED MODULES</span>
            {filteredModules.map((module) => (
              <button
                className="palette-module"
                key={module.id}
                onClick={() => addModule(module.id)}
              >
                <span
                  className="palette-dot"
                  style={{ backgroundColor: module.color }}
                />
                <span>{module.name}</span>
                <Plus size={14} />
              </button>
            ))}
          </div>
          <div className="palette-footer">
            <ShieldCheck size={14} />
            13 approved modules
          </div>
        </aside>
        <section className="builder-canvas">
          <div className="canvas-topline">
            <span>
              <span className="canvas-live-dot" />
              {nodes.length} nodes <b>·</b> {edges.length} connections
            </span>
            <span>
              JSON CONFIG <b>·</b> AUTOSAVE OFF
            </span>
          </div>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(connection) => {
              if (validConnection(connection))
                setEdges((current) =>
                  addEdge(
                    {
                      ...connection,
                      animated: true,
                      style: { stroke: "#bd8052", strokeWidth: 2 },
                    },
                    current,
                  ),
                );
              else
                setMessage(
                  "Connection blocked: the output and input types do not match.",
                );
            }}
            isValidConnection={validConnection}
            onNodeClick={(_, node) => setSelected(node as FlowNode)}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
          >
            <Background color="#b6bbb0" gap={22} size={1} />
            <MiniMap
              nodeColor={(node) => (node.data as FlowNode["data"]).color}
              maskColor="rgba(245, 244, 238, 0.76)"
            />
            <Controls />
          </ReactFlow>
          <div className="canvas-help">
            <span>Drag nodes to arrange</span>
            <span>Connect matching port types</span>
          </div>
        </section>
        <aside className="builder-inspector">
          {selected ? (
            <>
              <span className="eyebrow">NODE CONFIGURATION</span>
              <div className="inspector-title">
                <span
                  className="palette-dot"
                  style={{ backgroundColor: selected.data.color }}
                />
                <h3>{selected.data.title}</h3>
              </div>
              <p>{selected.data.description}</p>
              <div className="inspector-rule" />
              <span className="palette-label">FIELDS & RULES</span>
              {selected.data.fields.map((field) => (
                <label className="inspector-field" key={field}>
                  {field}
                  <input
                    value={selected.data.config[field] ?? ""}
                    placeholder={`Configure ${field.toLowerCase()}`}
                    onChange={(event) =>
                      updateConfig(field, event.target.value)
                    }
                  />
                </label>
              ))}
              <div className="port-summary">
                <span>INPUTS</span>
                <div>
                  {selected.data.inputs.length ? (
                    selected.data.inputs.map((input) => (
                      <code key={input}>{input}</code>
                    ))
                  ) : (
                    <small>Entry node</small>
                  )}
                </div>
                <span>OUTPUTS</span>
                <div>
                  {selected.data.outputs.length ? (
                    selected.data.outputs.map((output) => (
                      <code key={output}>{output}</code>
                    ))
                  ) : (
                    <small>Page view</small>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="inspector-empty-icon">
                <Settings2 size={21} />
              </div>
              <h3>Configuration</h3>
              <p>
                Select a module on the canvas to edit its fields and workflow
                settings.
              </p>
              <div className="inspector-rule" />
              <span className="palette-label">RELEASE HISTORY</span>
              <div className="release-list">
                {releases.slice(0, 5).map((release) => (
                  <div className="release-row" key={release.id}>
                    <span className="release-dot" />
                    <div>
                      <strong>
                        v{release.version}.0 · {release.status}
                      </strong>
                      <small>
                        {new Date(release.createdAt).toLocaleString()}
                      </small>
                    </div>
                    {release.version !== site.release && (
                      <button
                        title="Restore this release"
                        className="icon-button tiny"
                        onClick={() => void onRollback(release.id)}
                      >
                        <ArrowLeft size={14} />
                      </button>
                    )}
                  </div>
                ))}
                {releases.length === 0 && (
                  <small className="empty-history">
                    No published releases yet.
                  </small>
                )}
              </div>
              <div className="rollback-note">
                <Clock3 size={14} />
                Every publish creates a restorable version.
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function BuilderPreview({
  site,
  nodes,
  onClose,
}: {
  site: Site;
  nodes: FlowNode[];
  onClose: () => void;
}) {
  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="Draft site preview">
      <section className="preview-window" style={{ "--preview-accent": site.theme.accent } as React.CSSProperties}>
        <header className="preview-bar">
          <div className="preview-title"><span className="preview-mark" /><strong>{site.name}</strong><span>Draft preview</span></div>
          <button className="button button-outline" onClick={onClose}><X size={14} />Close preview</button>
        </header>
        <div className="preview-body">
          <aside className="preview-navigation"><span className="eyebrow">{site.slug.toUpperCase()}</span><strong>{site.name}</strong>{nodes.map((node) => <span key={node.id}><i style={{ background: node.data.color }} />{node.data.title}</span>)}</aside>
          <main className="preview-content">
            <div className="eyebrow">PREVIEW / {site.slug.toUpperCase()}</div>
            <h2>{site.name}</h2>
            <p>{site.description}</p>
            <div className="preview-modules">{nodes.map((node) => <article className="preview-module" key={node.id}><div><span className="palette-dot" style={{ backgroundColor: node.data.color }} /><span className="eyebrow">{node.data.moduleId.replaceAll('-', ' ').toUpperCase()}</span></div><h3>{node.data.title}</h3><p>{node.data.description}</p><div className="preview-fields">{node.data.fields.slice(0, 4).map((field) => <span key={field}>{node.data.config[field] || field}</span>)}</div></article>)}</div>
            {nodes.length === 0 && <div className="empty-panel">No modules in this draft yet.</div>}
          </main>
        </div>
      </section>
    </div>
  );
}

function AssignmentPanel({
  site,
  initialMode,
}: {
  site: Site;
  initialMode: "consumption" | "return" | null;
}) {
  const token = localStorage.getItem("opshub-token") ?? "";
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [consumption, setConsumption] = useState<OperationalLog[]>([]);
  const [returns, setReturns] = useState<OperationalLog[]>([]);
  const [mode, setMode] = useState<"consumption" | "return" | null>(
    initialMode,
  );
  const [selectedId, setSelectedId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [condition, setCondition] = useState("Unused");
  const [message, setMessage] = useState("");

  async function refresh() {
    const [assignmentData, consumptionData, returnData] = await Promise.all([
      api<{ assignments: Assignment[] }>(`/${site.siteId}/assignments`, token),
      api<{ consumption: OperationalLog[] }>(
        `/${site.siteId}/consumption`,
        token,
      ),
      api<{ returns: OperationalLog[] }>(`/${site.siteId}/returns`, token),
    ]);
    setAssignments(assignmentData.assignments);
    setConsumption(consumptionData.consumption);
    setReturns(returnData.returns);
  }
  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ assignments: Assignment[] }>(`/${site.siteId}/assignments`, token),
      api<{ consumption: OperationalLog[] }>(
        `/${site.siteId}/consumption`,
        token,
      ),
      api<{ returns: OperationalLog[] }>(`/${site.siteId}/returns`, token),
    ])
      .then(([assignmentData, consumptionData, returnData]) => {
        if (!active) return;
        setAssignments(assignmentData.assignments);
        setConsumption(consumptionData.consumption);
        setReturns(returnData.returns);
      })
      .catch((error: unknown) => {
        if (active)
          setMessage(
            error instanceof Error
              ? error.message
              : "Unable to load assignments",
          );
      });
    return () => {
      active = false;
    };
  }, [site.siteId, token]);

  async function submitLog(event: React.FormEvent) {
    event.preventDefault();
    if (!mode || !selectedId) return;
    const assignment = assignments.find((item) => item.id === selectedId);
    if (!assignment) return;
    setMessage("");
    try {
      const resource = mode === "return" ? "returns" : "consumption";
      await api(`/${site.siteId}/${resource}`, token, {
        method: "POST",
        body: JSON.stringify({
          title: `${mode === "return" ? "Return" : "Consumption"} · ${assignment.itemName}`,
          assignmentId: assignment.id,
          quantity,
          condition,
          disposition: "Review",
          notes,
          workOrder: assignment.requestId,
        }),
      });
      await refresh();
      setMode(null);
      setNotes("");
      setMessage(
        `${mode === "return" ? "Return" : "Consumption"} recorded against ${assignment.itemName}.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not save record",
      );
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={`${site.name.toUpperCase()} / FIELD OPERATIONS`}
        title={
          initialMode === "consumption"
            ? "Consumption tracking"
            : initialMode === "return"
              ? "Return management"
              : "Product dispatches"
        }
        description="Keep store transfers and customer deliveries linked to the request, from dispatch through hand-off."
      />
      {message && (
        <div className="notice-band">
          <Activity size={16} />
          {message}
        </div>
      )}
      <div className="assignment-list">
        {assignments.map((item) => (
          <article className="assignment-card" key={item.id}>
            <div className="assignment-icon">
              <Boxes size={18} />
            </div>
            <div className="assignment-copy">
              <span className="eyebrow">PRODUCT DISPATCH</span>
              <strong>{item.itemName}</strong>
              <span>
                {item.quantity} units · {item.assignee} ·{" "}
                {new Date(item.createdAt).toLocaleDateString()}
              </span>
            </div>
            <span className="assignment-status">{item.status}</span>
            <div className="assignment-actions">
              <button
                className="button button-outline"
                onClick={() => {
                  setSelectedId(item.id);
                  setMode("consumption");
                }}
              >
                <Activity size={14} />
                Log usage
              </button>
              <button
                className="button button-outline"
                onClick={() => {
                  setSelectedId(item.id);
                  setMode("return");
                }}
              >
                <ArrowDownToLine size={14} />
                Return
              </button>
            </div>
          </article>
        ))}
        {assignments.length === 0 && (
          <div className="empty-panel">
            <div className="empty-panel-icon">
              <Boxes size={22} />
            </div>
            <strong>No products dispatched yet</strong>
            <span>Approve a store request to prepare its first dispatch.</span>
          </div>
        )}
      </div>
      <div className="operational-history">
        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">FIELD USAGE</span>
              <h2>Consumption records</h2>
            </div>
            <span className="count-pill">{consumption.length}</span>
          </div>
          {consumption.map((item) => (
            <div className="log-row" key={item.id}>
              <strong>{item.title}</strong>
              <span>
                {item.quantity ?? 0} units · {item.actor}
              </span>
            </div>
          ))}
          {consumption.length === 0 && (
            <div className="log-empty">No usage recorded.</div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">RETURNS</span>
              <h2>Return records</h2>
            </div>
            <span className="count-pill">{returns.length}</span>
          </div>
          {returns.map((item) => (
            <div className="log-row" key={item.id}>
              <strong>{item.title}</strong>
              <span>
                {item.quantity ?? 0} units ·{" "}
                {item.condition ?? "Condition pending"}
              </span>
            </div>
          ))}
          {returns.length === 0 && (
            <div className="log-empty">No product returns recorded.</div>
          )}
        </section>
      </div>
      {mode && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMode(null);
          }}
        >
          <form className="modal" onSubmit={(event) => void submitLog(event)}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">
                  {mode === "return" ? "RETURN INTAKE" : "FIELD USAGE"}
                </span>
                <h2>
                  {mode === "return" ? "Record a return" : "Record consumption"}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setMode(null)}
              >
                <X size={17} />
              </button>
            </div>
            <label>
              Assignment
              <select
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
                required
              >
                {assignments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.itemName} · {item.assignee}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-pair">
              <label>
                Quantity
                <input
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(event) => setQuantity(Number(event.target.value))}
                  required
                />
              </label>
              {mode === "return" && (
                <label>
                  Condition
                  <select
                    value={condition}
                    onChange={(event) => setCondition(event.target.value)}
                  >
                    <option>Unused</option>
                    <option>Good</option>
                    <option>Damaged</option>
                    <option>Faulty</option>
                  </select>
                </label>
              )}
            </div>
            <label>
              Work order / notes
              <input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Optional reference"
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-outline"
                onClick={() => setMode(null)}
              >
                Cancel
              </button>
              <button className="button button-primary">
                Save record <Check size={14} />
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function RepairPanel({ site, requests }: { site: Site; requests: OpsRequest[] }) {
  const token = localStorage.getItem("opshub-token") ?? "";
  const [records, setRecords] = useState<OperationalLog[]>([]);
  const [title, setTitle] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [fault, setFault] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [repairNotes, setRepairNotes] = useState("");
  const [requestId, setRequestId] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  async function refresh() {
    const result = await api<{ repairs: OperationalLog[] }>(
      `/${site.siteId}/repairs`,
      token,
    );
    setRecords(result.repairs);
  }
  useEffect(() => {
    let active = true;
    api<{ repairs: OperationalLog[] }>(`/${site.siteId}/repairs`, token)
      .then((result) => {
        if (active) setRecords(result.repairs);
      })
      .catch((error: unknown) => {
        if (active)
          setMessage(
            error instanceof Error
              ? error.message
              : "Unable to load repair logs",
          );
      });
    return () => {
      active = false;
    };
  }, [site.siteId, token]);
  async function addRepair(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await api(`/${site.siteId}/repairs`, token, {
        method: "POST",
        body: JSON.stringify({
          title,
          ...(requestId ? { requestId } : {}),
          serialNumber,
          fault,
          diagnosis,
          repairNotes,
        }),
      });
      await refresh();
      setTitle("");
      setSerialNumber("");
      setFault("");
      setDiagnosis("");
      setRepairNotes("");
      setRequestId("");
      setMessage("Repair log saved to this site.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to save repair",
      );
    } finally {
      setSaving(false);
    }
  }
  async function updateStatus(record: OperationalLog, status: string) {
    try {
      await api(`/${site.siteId}/repairs/${record.id}`, token, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh();
      setMessage(`Repair updated: ${status}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to update repair"); }
  }
  return (
    <>
      <PageHeader
        eyebrow={`${site.name.toUpperCase()} / SERVICE`}
        title="Product service desk"
        description="Track customer devices through diagnosis, repair and ready-for-pickup."
      />
      <div className="repair-layout">
        <form className="invite-panel repair-form" onSubmit={addRepair}>
          <div className="eyebrow">NEW REPAIR RECORD</div>
          <h2>Log a repair</h2>
          <label>
            Repair title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </label>
          <label>
            Link to service request
            <select value={requestId} onChange={(event) => setRequestId(event.target.value)}>
              <option value="">Create repair without a request link</option>
              {requests.map((request) => <option key={request.id} value={request.id}>{request.title} · {request.requester}</option>)}
            </select>
          </label>
          <label>
            Serial number
            <input
              value={serialNumber}
              onChange={(event) => setSerialNumber(event.target.value)}
              required
            />
          </label>
          <label>
            Reported fault
            <input
              value={fault}
              onChange={(event) => setFault(event.target.value)}
              required
            />
          </label>
          <label>
            Diagnosis
            <textarea
              value={diagnosis}
              onChange={(event) => setDiagnosis(event.target.value)}
              rows={2}
            />
          </label>
          <label>
            Repair notes
            <textarea
              value={repairNotes}
              onChange={(event) => setRepairNotes(event.target.value)}
              rows={3}
            />
          </label>
          {message && <div className="member-notice">{message}</div>}
          <button className="button button-primary" disabled={saving}>
            <Wrench size={15} />
            {saving ? "Saving..." : "Save repair log"}
          </button>
        </form>
        <section className="repair-records">
          <div className="panel-head">
            <div>
              <span className="eyebrow">SERVICE HISTORY</span>
              <h2>{records.length} repair records</h2>
            </div>
            <span className="count-pill">{records.length}</span>
          </div>
          {records.map((record) => (
            <article className="repair-record" key={record.id}>
              <div className="repair-record-head">
                <div className="repair-record-icon">
                  <Wrench size={16} />
                </div>
                <div>
                  <strong>{record.title}</strong>
                  <span>
                    {record.serialNumber || "Serial not supplied"} ·{" "}
                    {new Date(record.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <span className={`request-status status-${(record.status ?? "Received").toLowerCase().replaceAll(" ", "-")}`}>{record.status ?? "Received"}</span>
              </div>
              {record.requestId && <p><b>Service request</b> {requests.find((request) => request.id === record.requestId)?.title ?? "Linked request"}</p>}
              <p>
                <b>Fault</b> {record.fault || "Not recorded"}
              </p>
              <p>
                <b>Diagnosis</b> {record.diagnosis || "Pending"}
              </p>
              {record.repairNotes && (
                <p>
                  <b>Work</b> {record.repairNotes}
                </p>
              )}
              {record.status !== "Completed" && <label className="repair-status-control">Update progress
                <select value={record.status ?? "Received"} onChange={(event) => updateStatus(record, event.target.value)}>
                  {["Received", "Diagnosing", "In repair", "Ready for pickup", "Completed"].slice(["Received", "Diagnosing", "In repair", "Ready for pickup", "Completed"].indexOf(record.status ?? "Received")).map((status) => <option key={status}>{status}</option>)}
                </select>
              </label>}
            </article>
          ))}
          {records.length === 0 && (
            <div className="empty-panel">
              <div className="empty-panel-icon">
                <Wrench size={22} />
              </div>
              <strong>No repair history yet</strong>
              <span>New service records will appear here.</span>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function UsersPanel({ site }: { site: Site }) {
  const token = localStorage.getItem("opshub-token") ?? "";
  const [members, setMembers] = useState<SiteMember[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"Member" | "Manager">("Member");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ users: SiteMember[] }>(`/${site.siteId}/users`, token)
      .then((data) => setMembers(data.users))
      .catch((error: unknown) =>
        setNotice(
          error instanceof Error ? error.message : "Unable to load users",
        ),
      );
  }, [site.siteId, token]);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    try {
      const result = await api<{ user: SiteMember }>(
        `/${site.siteId}/users`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ name, email, password, phone: phone || undefined, role }),
        },
      );
      setMembers((current) => [...current, result.user]);
      setName("");
      setEmail("");
      setPhone("");
      setPassword("");
      setNotice("Invitation created for this site.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invitation failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={`${site.name.toUpperCase()} / ACCESS`}
        title="Team & access"
        description="Manage site membership separately from each person's global OpsHub login."
      />
      <div className="member-layout">
        <section className="member-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">SITE MEMBERS</span>
              <h2>{members.length} people</h2>
            </div>
            <span className="member-scope">/{site.slug}</span>
          </div>
          <div className="member-list">
            {members.map((member) => (
              <div className="member-row" key={member.id}>
                <div className="avatar member-avatar">
                  {member.name
                    .split(" ")
                    .map((part) => part[0])
                    .join("")
                    .slice(0, 2)}
                </div>
                <div className="member-info">
                  <strong>{member.name}</strong>
                  <span>{member.email}{member.phone ? ` · ${member.phone}` : ""}</span>
                </div>
                <span
                  className={`member-role role-${member.role.toLowerCase()}`}
                >
                  {member.role}
                </span>
              </div>
            ))}
            {members.length === 0 && (
              <div className="empty-state">
                No members are assigned to this site.
              </div>
            )}
          </div>
        </section>
        <form className="invite-panel" onSubmit={invite}>
          <div className="eyebrow">ADD TO THIS SITE</div>
          <h2>Invite a teammate</h2>
          <p>They'll get a global login with this site role only.</p>
          <label>
            Full name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Phone for MiniMoth OTP
            <input
              type="tel"
              autoComplete="tel"
              placeholder="+919876543210"
              pattern="\+[1-9][0-9]{7,14}"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          <label>
            Temporary password
            <input
              type="password"
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <label>
            Site role
            <select
              value={role}
              onChange={(event) =>
                setRole(event.target.value as "Member" | "Manager")
              }
            >
              <option>Member</option>
              <option>Manager</option>
            </select>
          </label>
          {notice && <div className="member-notice">{notice}</div>}
          <button className="button button-primary" disabled={saving}>
            <Users size={15} />
            {saving ? "Adding..." : "Add to site"}
          </button>
        </form>
      </div>
    </>
  );
}

function ExcelImportButton({ siteId }: { siteId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function importWorkbook(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(`/api/${siteId}/reports/import`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("opshub-token") ?? ""}`,
        },
        body,
      });
      const result = (await response.json()) as {
        imported?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "Import failed");
      setMessage(`${result.imported ?? 0} rows imported`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <label className="button button-outline import-button">
      <Upload size={15} />
      {busy ? "Importing..." : "Import Excel"}
      <input
        type="file"
        accept=".xlsx"
        disabled={busy}
        onChange={(event) => {
          void importWorkbook(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {message && <span className="import-message">{message}</span>}
    </label>
  );
}

function InventoryTable({ inventory, canManage, onEdit, onDelete }: { inventory: InventoryItem[]; canManage: boolean; onEdit: (item: InventoryItem) => void; onDelete: (id: string) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ITEM</th>
            <th>SKU</th>
            <th>CATEGORY</th>
            <th>LOCATION</th>
            <th>ON HAND</th>
            <th>REORDER AT</th>
            <th>UNIT PRICE</th>
            <th>STATUS</th>
            {canManage && <th>ACTIONS</th>}
          </tr>
        </thead>
        <tbody>
          {inventory.map((item) => (
            <tr key={item.id}>
              <td>
                <div className="item-cell">
                  <span className="item-icon">
                    <Package size={15} />
                  </span>
                  <strong>{item.name}</strong>
                </div>
              </td>
              <td className="mono-cell">{item.sku}</td>
              <td>{item.category}</td>
              <td>{item.location}</td>
              <td>
                <strong>{item.quantity}</strong>
                <span className="unit-label"> {item.unit}</span>
              </td>
              <td>
                {item.reorderAt} {item.unit}
              </td>
              <td>{formatCurrency(item.price)}</td>
              <td>
                <span
                  className={`stock-status ${item.quantity <= item.reorderAt ? "is-low" : ""}`}
                >
                  <i />
                  {item.quantity <= item.reorderAt ? "Reorder" : "Healthy"}
                </span>
              </td>
              {canManage && <td><div className="inventory-actions"><button className="icon-button" title={`Edit ${item.name}`} onClick={() => onEdit(item)}><Pencil size={14} /></button><button className="icon-button danger-action" title={`Delete ${item.name}`} onClick={() => onDelete(item.id)}><Trash2 size={14} /></button></div></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {inventory.length === 0 && (
        <div className="empty-state">
          No items yet. Add your first stock item to begin.
        </div>
      )}
    </div>
  );
}
function RequestList({
  requests,
  approvals,
  onApprove,
}: {
  requests: OpsRequest[];
  approvals: boolean;
  onApprove: (id: string) => void;
}) {
  if (!requests.length)
    return (
      <div className="empty-panel">
        <div className="empty-panel-icon">
          <CheckCheck size={22} />
        </div>
        <strong>
          {approvals ? "Nothing waiting on a decision" : "No requests here yet"}
        </strong>
        <span>New workflow activity will appear here.</span>
      </div>
    );
  return (
    <div className="request-table">
      <div className="request-table-head">
        <span>REQUEST</span>
        <span>REQUESTER</span>
        <span>ITEMS</span>
        <span>PRIORITY</span>
        <span>STATUS</span>
        <span>ACTION</span>
      </div>
      {requests.map((item) => (
        <div className="request-row" key={item.id}>
          <div className="request-name">
            <span className="request-icon">
              <ClipboardList size={16} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <small>{new Date(item.createdAt).toLocaleDateString()}</small>
            </span>
          </div>
          <span>{item.requester}{item.sourceSiteName && <small className="request-origin">From {item.sourceSiteName}</small>}</span>
          <span>
            {item.quantity} × {item.itemName}
          </span>
          <span>
            <span className={`priority ${item.priority.toLowerCase()}`}>
              {item.priority}
            </span>
          </span>
          <span>
            <span
              className={`request-status status-${item.status.toLowerCase().replaceAll(" ", "-")}`}
            >
              {item.status}
            </span>
          </span>
          <span>
            {approvals && item.status === "Pending approval" ? (
              <button
                className="approve-button"
                onClick={() => onApprove(item.id)}
              >
                <Check size={14} />
                Approve & issue
              </button>
            ) : (
              <button className="icon-button" title="View details">
                <ArrowRight size={15} />
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
function Analytics({
  inventory,
  requests,
  chartData,
}: {
  inventory: InventoryItem[];
  requests: OpsRequest[];
  chartData: { name: string; available: number; reorder: number }[];
}) {
  const requestCount = requests.length;
  const assigned = requests.filter((item) => item.status === "Assigned").length;
  const lowStock = inventory.filter(
    (item) => item.quantity <= item.reorderAt,
  ).length;
  return (
    <>
      <div className="analytics-kpis">
        <div className="analytics-kpi">
          <span>REQUESTS THIS PERIOD</span>
          <strong>{requestCount}</strong>
          <small>Across current site</small>
        </div>
        <div className="analytics-kpi">
          <span>FULFILLED</span>
          <strong>
            {requestCount ? Math.round((assigned / requestCount) * 100) : 0}
            <i>%</i>
          </strong>
          <small>Request to assignment</small>
        </div>
        <div className="analytics-kpi">
          <span>STOCK AT RISK</span>
          <strong>{lowStock}</strong>
          <small>Items at reorder point</small>
        </div>
        <div className="analytics-kpi">
          <span>INVENTORY VALUE</span>
          <strong>
            {formatCurrency(inventory.reduce((sum, item) => sum + item.quantity * item.price, 0))}
          </strong>
          <small>Quantity × unit price</small>
        </div>
      </div>
      <section className="panel analytics-chart-panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">INVENTORY HEALTH</span>
            <h2>Available quantity by item</h2>
          </div>
          <span className="chart-period">
            CURRENT SNAPSHOT <ChevronDown size={13} />
          </span>
        </div>
        <div className="analytics-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 12, right: 12, left: 0, bottom: 6 }}
            >
              <CartesianGrid
                strokeDasharray="3 5"
                vertical={false}
                stroke="#e9e8e1"
              />
              <XAxis
                dataKey="name"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "#717a74", fontSize: 12 }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fill: "#717a74", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{ border: "1px solid #e5e4dc", borderRadius: 6 }}
              />
              <Bar
                dataKey="available"
                fill="#3c7968"
                radius={[4, 4, 0, 0]}
                barSize={32}
              />
              <Bar
                dataKey="reorder"
                fill="#d9a17a"
                radius={[4, 4, 0, 0]}
                barSize={32}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </>
  );
}
function Metric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: string;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-label">
        <span className="metric-mark" />
        {label}
      </div>
      <strong>{value}</strong>
      <span className="metric-detail">{detail}</span>
    </div>
  );
}
function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </section>
  );
}

function ModalForm({
  type,
  inventory,
  initialItem,
  onClose,
  onSite,
  onRequest,
  onItem,
  onUpdateItem,
}: {
  type: Exclude<Modal, null>;
  inventory: InventoryItem[];
  initialItem?: InventoryItem;
  onClose: () => void;
  onSite: (name: string) => void;
  onRequest: (
    title: string,
    quantity: number,
    itemId: string,
    priority: string,
  ) => void;
  onItem: (values: {
    name: string;
    sku: string;
    quantity: number;
    price: number;
    category: string;
  }) => void;
  onUpdateItem: (id: string, values: { name: string; sku: string; quantity: number; price: number; category: string }) => void;
}) {
  const [name, setName] = useState(initialItem?.name ?? "");
  const [sku, setSku] = useState(initialItem?.sku ?? "");
  const [category, setCategory] = useState(initialItem?.category ?? "General");
  const [quantity, setQuantity] = useState(initialItem?.quantity ?? 1);
  const [price, setPrice] = useState(initialItem?.price ?? 0);
  const [itemId, setItemId] = useState(inventory[0]?.id ?? "");
  const [priority, setPriority] = useState("Normal");
  const title =
    type === "site"
      ? "Create a site"
      : type === "request"
        ? "New product request"
        : type === "edit-item" ? "Edit inventory item" : "Add inventory item";
  const isItemForm = type === "item" || type === "edit-item";
  function updateField(key: string, value: string | number) {
    if (key === "name" || key === "title") setName(String(value));
    else if (key === "sku") setSku(String(value));
    else if (key === "category") setCategory(String(value));
    else if (key === "quantity") setQuantity(Number(value));
    else if (key === "price") setPrice(Number(value));
    else if (key === "itemId") setItemId(String(value));
    else if (key === "priority") setPriority(String(value));
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal"
        onSubmit={(event) => {
          event.preventDefault();
          if (type === "site") onSite(name);
          else if (type === "request")
            onRequest(name, quantity, itemId, priority);
          else if (type === "edit-item" && initialItem)
            onUpdateItem(initialItem.id, { name, sku, quantity, price, category });
          else onItem({ name, sku, quantity, price, category });
        }}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">
              {type === "site"
                ? "SITE PROVISIONING"
                : type === "request"
                  ? "REQUEST INTAKE"
                  : "STOCK LEDGER"}
            </span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        {type === "site" && (
          <>
            <label>
              Site name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Pune Flagship Store"
                required
                autoFocus
              />
            </label>
            <div className="modal-hint">
              <Sparkles size={15} />A new isolated workspace will be provisioned
              with a starter configuration.
            </div>
          </>
        )}
        {type === "request" && (
          <>
            <GeneratedFields fields={MODULE_FIELD_SCHEMAS.request ?? []} inventory={inventory} values={{ title: name, itemId, quantity, priority }} onChange={updateField} />
            <div className="modal-hint">
              <ClipboardCheck size={15} />
              This request will be routed to a site Manager.
            </div>
          </>
        )}
        {isItemForm && (
          <>
            <GeneratedFields fields={MODULE_FIELD_SCHEMAS.inventory ?? []} inventory={inventory} values={{ name, sku, category, quantity, price }} onChange={updateField} />
            <div className="formula-note">
              VALUE = QUANTITY × UNIT PRICE{" "}
              <strong>{formatCurrency(quantity * price)}</strong>
            </div>
          </>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-outline"
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            {type === "site"
              ? "Create site"
              : type === "request"
                ? "Send for approval"
                : type === "edit-item" ? "Save changes" : "Add item"}
            <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}

function GeneratedFields({ fields, inventory, values, onChange }: { fields: FieldSchema[]; inventory: InventoryItem[]; values: Record<string, string | number>; onChange: (key: string, value: string | number) => void }) {
  return <div className="generated-fields">{fields.map((field, index) => <label key={field.key}>{field.label}{field.type === "select" ? <select value={values[field.key] ?? ""} required={field.required} onChange={(event) => onChange(field.key, event.target.value)}>{field.options === "inventory" ? inventory.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.quantity} available</option>) : <><option value="Normal">Normal</option><option value="Urgent">Urgent</option></>}</select> : <input autoFocus={index === 0} type={field.type} min={field.min} step={field.step} value={values[field.key] ?? ""} required={field.required} onChange={(event) => onChange(field.key, field.type === "number" ? Number(event.target.value) : event.target.value)} />}</label>)}</div>;
}

export default App;
