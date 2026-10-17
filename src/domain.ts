export type Role = 'Public' | 'Member' | 'Manager' | 'Admin'
export type SiteTheme = { accent: string; canvas: string; ink: string; label: string }
export type ModuleKey =
  | 'auth' | 'users' | 'inventory' | 'shell' | 'request' | 'approval'
  | 'material-assignment' | 'assignment-ui' | 'consumption' | 'returns'
  | 'pcb-repair' | 'analytics' | 'reports'

export type SitePage = { id: string; label: string; module: ModuleKey; icon: string }
export type Site = {
  siteId: string
  slug: string
  name: string
  description: string
  status: 'Live' | 'Draft'
  theme: SiteTheme
  modules: ModuleKey[]
  pages: SitePage[]
  roles: Role[]
  updatedAt: string
  release: number
  role?: Role
  metrics: { stockValue: number; openRequests: number; lowStock: number; completed: number }
}

export type ModuleDefinition = {
  id: ModuleKey
  name: string
  category: string
  description: string
  input: string[]
  output: string[]
  color: string
  fields: string[]
}

export type FieldSchema = {
  key: string
  label: string
  type: 'text' | 'number' | 'select'
  required?: boolean
  min?: number
  step?: number
  options?: 'inventory' | 'priority'
}

export const MODULE_FIELD_SCHEMAS: Partial<Record<ModuleKey, FieldSchema[]>> = {
  inventory: [
    { key: 'name', label: 'Item name', type: 'text', required: true },
    { key: 'sku', label: 'SKU', type: 'text', required: true },
    { key: 'category', label: 'Category', type: 'text', required: true },
    { key: 'quantity', label: 'Quantity', type: 'number', min: 0, required: true },
    { key: 'price', label: 'Unit price', type: 'number', min: 0, step: 0.01, required: true },
  ],
  request: [
    { key: 'title', label: 'Request or store transfer', type: 'text', required: true },
    { key: 'itemId', label: 'Product or service part', type: 'select', options: 'inventory', required: true },
    { key: 'quantity', label: 'Quantity', type: 'number', min: 1, required: true },
    { key: 'priority', label: 'Priority', type: 'select', options: 'priority', required: true },
  ],
}

export type InventoryItem = {
  id: string
  sku: string
  name: string
  category: string
  quantity: number
  reorderAt: number
  unit: string
  price: number
  location: string
  siteId: string
}

export type OpsRequest = {
  id: string
  title: string
  requester: string
  quantity: number
  itemName: string
  status: 'Pending approval' | 'Approved' | 'Assigned' | 'Rejected'
  priority: 'Normal' | 'Urgent'
  createdAt: string
  siteId: string
  sourceSiteId?: string
  sourceSiteName?: string
  sourceItemName?: string
  serviceStatus?: string
}

export type Release = { id: string; version: number; status: string; createdAt: string; actor: string }
export type SiteMember = { id: string; name: string; email: string; phone?: string; role: Role }
export type Assignment = { id: string; requestId: string; itemName: string; quantity: number; assignee: string; status: string; createdAt: string; siteId: string }
export type OperationalLog = { id: string; title: string; actor: string; createdAt: string; updatedAt?: string; requestId?: string; status?: string; quantity?: number; condition?: string; disposition?: string; serialNumber?: string; fault?: string; diagnosis?: string; repairNotes?: string }

export const MODULES: ModuleDefinition[] = [
  { id: 'auth', name: 'Authentication & RBAC', category: 'Foundation', description: 'Global sign-in, scoped roles and permissions.', input: [], output: ['Session'], color: '#61796b', fields: ['Role', 'Permission set'] },
  { id: 'users', name: 'User Management', category: 'Foundation', description: 'Invite and govern people across sites.', input: ['Session'], output: ['Member'], color: '#8c8068', fields: ['Name', 'Email', 'Site role'] },
  { id: 'inventory', name: 'Retail Inventory', category: 'Operations', description: 'Product availability, store locations, reorder points and value.', input: ['Session'], output: ['StockItem'], color: '#31806d', fields: ['SKU', 'Product', 'Category', 'Quantity', 'Store location', 'Retail price'] },
  { id: 'shell', name: 'Dashboard Shell / Navigation / Forms', category: 'Foundation', description: 'Site-specific navigation and generated forms.', input: ['Session'], output: ['Page'], color: '#647f87', fields: ['Page title', 'Navigation label', 'Layout'] },
  { id: 'request', name: 'Store & Service Request', category: 'Workflow', description: 'Capture replenishment, customer service and store transfer requests.', input: ['Member', 'StockItem'], output: ['Request'], color: '#c98249', fields: ['Request title', 'Product', 'Quantity', 'Priority', 'Requester'] },
  { id: 'approval', name: 'Approval', category: 'Workflow', description: 'Role-based decisions with an auditable trail.', input: ['Request'], output: ['ApprovedRequest'], color: '#b56b54', fields: ['Approver role', 'Decision', 'Comment'] },
  { id: 'material-assignment', name: 'Product Dispatch', category: 'Workflow', description: 'Reserve approved products and prepare a store transfer or delivery.', input: ['ApprovedRequest', 'StockItem'], output: ['Assignment'], color: '#5f8f77', fields: ['Store or customer', 'Quantity', 'Dispatch location'] },
  { id: 'assignment-ui', name: 'Dispatch Board', category: 'Experience', description: 'Track products as they move from the distribution hub to a store or customer.', input: ['Assignment'], output: ['Receipt'], color: '#6686a0', fields: ['Destination', 'Delivery route', 'Handover status'] },
  { id: 'consumption', name: 'Consumption Tracking', category: 'Operations', description: 'Record usage against an issued assignment.', input: ['Assignment'], output: ['Consumption'], color: '#5c887c', fields: ['Quantity used', 'Work order', 'Notes'] },
  { id: 'returns', name: 'Return Management', category: 'Operations', description: 'Return unused, faulty or repairable materials.', input: ['Assignment', 'Consumption'], output: ['Return'], color: '#9b8063', fields: ['Return quantity', 'Condition', 'Disposition'] },
  { id: 'pcb-repair', name: 'Customer Product Repair', category: 'Service', description: 'Track device diagnostics, warranty checks, repairs and ready-for-pickup updates.', input: ['Request'], output: ['RepairLog'], color: '#777f9b', fields: ['Product serial number', 'Customer fault', 'Diagnosis', 'Repair notes'] },
  { id: 'analytics', name: 'Analytics Dashboard', category: 'Insights', description: 'Site-scoped charts, trends and operational KPIs.', input: ['StockItem', 'Request', 'Assignment'], output: ['Insight'], color: '#477f91', fields: ['Metric', 'Date range', 'Chart type'] },
  { id: 'reports', name: 'Reports & Excel Integration', category: 'Insights', description: 'Role-gated Excel import and export.', input: ['StockItem', 'Request', 'Assignment'], output: ['Workbook'], color: '#778a4c', fields: ['Report', 'Columns', 'Access role'] },
]

export const PRESETS = [
  { id: 'inventory-starter', name: 'Inventory Starter', description: 'Stock ledger, analytics and Excel reports.', modules: ['auth', 'users', 'shell', 'inventory', 'analytics', 'reports'] as ModuleKey[] },
  { id: 'approval-chain', name: 'Store Fulfilment', description: 'Request, approve, dispatch and track a product hand-off.', modules: ['auth', 'users', 'shell', 'inventory', 'request', 'approval', 'material-assignment', 'assignment-ui', 'consumption', 'returns'] as ModuleKey[] },
  { id: 'repair-shop', name: 'Customer Service Centre', description: 'Customer intake, warranty checks, product repairs and returns.', modules: ['auth', 'users', 'shell', 'request', 'approval', 'pcb-repair', 'returns', 'analytics', 'reports'] as ModuleKey[] },
]

export const api = async <T,>(path: string, token: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}
