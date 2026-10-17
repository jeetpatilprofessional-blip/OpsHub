import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import cors from 'cors'
import ExcelJS from 'exceljs'
import express from 'express'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import pg from 'pg'
import { z } from 'zod'
import { MiniMoth, MiniMothError } from '@minimoth/sdk-node'

const { Pool } = pg
const root = path.dirname(fileURLToPath(import.meta.url))
const seedData = JSON.parse(await readFile(path.join(root, 'seed-data.json'), 'utf8'))
const jwtSecret = process.env.JWT_SECRET || 'opshub-local-demo-secret-change-this'
export const pool = process.env.OPSHUB_OFFLINE_DEMO !== '1' && process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
const minimothClient = process.env.MINIMOTH_API_KEY ? new MiniMoth({ apiKey: process.env.MINIMOTH_API_KEY }) : null

const roleRank = { Public: 0, Member: 1, Manager: 2, Admin: 3 }
const allowedModules = new Set(['auth', 'users', 'inventory', 'shell', 'request', 'approval', 'material-assignment', 'assignment-ui', 'consumption', 'returns', 'pcb-repair', 'analytics', 'reports'])
const modulePorts = {
  auth: { inputs: [], outputs: ['Session'] },
  users: { inputs: ['Session'], outputs: ['Member'] },
  inventory: { inputs: ['Session'], outputs: ['StockItem'] },
  shell: { inputs: ['Session'], outputs: ['Page'] },
  request: { inputs: ['Member', 'StockItem'], outputs: ['Request'] },
  approval: { inputs: ['Request'], outputs: ['ApprovedRequest'] },
  'material-assignment': { inputs: ['ApprovedRequest', 'StockItem'], outputs: ['Assignment'] },
  'assignment-ui': { inputs: ['Assignment'], outputs: ['Receipt'] },
  consumption: { inputs: ['Assignment'], outputs: ['Consumption'] },
  returns: { inputs: ['Assignment', 'Consumption'], outputs: ['Return'] },
  'pcb-repair': { inputs: ['Request'], outputs: ['RepairLog'] },
  analytics: { inputs: ['StockItem', 'Request', 'Assignment'], outputs: ['Insight'] },
  reports: { inputs: ['StockItem', 'Request', 'Assignment'], outputs: ['Workbook'] },
}
const requiredModuleInputs = { approval: ['Request'] }
const siteInput = z.object({ name: z.string().trim().min(2).max(80) })
const phoneInput = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Phone must use E.164 format, for example +919876543210')
const globalUserInput = z.object({ name: z.string().trim().min(1).max(100), email: z.string().email(), password: z.string().min(10).max(128), phone: phoneInput.optional(), siteId: z.string().uuid(), role: z.enum(['Public', 'Member', 'Manager', 'Admin']).default('Member') })
const siteUserInput = z.object({ name: z.string().trim().min(1).max(100), email: z.string().email(), password: z.string().min(10).max(128), phone: phoneInput.optional(), role: z.enum(['Public', 'Member', 'Manager', 'Admin']).default('Member') })
const otpSendInput = z.object({ phone: phoneInput })
const otpVerifyInput = z.object({ phone: phoneInput, otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits') })
const inventoryInput = z.object({
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().min(1).max(60),
  category: z.string().trim().max(60).default('General'),
  quantity: z.number().int().min(0),
  reorderAt: z.number().int().min(0).default(5),
  unit: z.string().trim().min(1).max(24).default('units'),
  price: z.number().finite().min(0),
  location: z.string().trim().max(120).default('Main store'),
})
const inventoryPatch = inventoryInput.partial().refine((value) => Object.keys(value).length > 0, 'Provide at least one inventory field')
const requestInput = z.object({
  title: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive(),
  itemId: z.string().uuid(),
  priority: z.enum(['Normal', 'Urgent']).default('Normal'),
})
const approvalInput = z.object({ requestId: z.string().uuid(), decision: z.enum(['approve', 'reject']).default('approve'), comment: z.string().max(1000).default('') })
const graphNodeInput = z.object({ id: z.string().min(1).max(100), data: z.object({ moduleId: z.enum([...allowedModules]), inputs: z.array(z.string()), outputs: z.array(z.string()) }).passthrough() }).passthrough()
const graphEdgeInput = z.object({ source: z.string(), target: z.string(), sourceHandle: z.string(), targetHandle: z.string() }).passthrough()
const componentInput = z.object({ nodes: z.array(graphNodeInput).max(100), edges: z.array(graphEdgeInput).max(250), modules: z.array(z.string()).max(13) })
const logInput = z.object({ title: z.string().trim().min(1).max(160), assignmentId: z.string().uuid(), quantity: z.number().int().positive(), notes: z.string().max(1000).default(''), condition: z.enum(['Unused', 'Good', 'Damaged', 'Faulty']).optional(), disposition: z.string().max(100).optional(), workOrder: z.string().max(100).optional() })
const repairInput = z.object({ requestId: z.string().uuid().optional(), title: z.string().trim().min(1).max(160), serialNumber: z.string().trim().min(1).max(100), fault: z.string().trim().min(1).max(1000), diagnosis: z.string().max(2000).default(''), repairNotes: z.string().max(3000).default('') })
const repairStatusInput = z.object({ status: z.enum(['Received', 'Diagnosing', 'In repair', 'Ready for pickup', 'Completed']) })
const defaultPages = [
  { module: 'inventory', id: 'inventory', label: 'Inventory', icon: 'Package' },
  { module: 'request', id: 'requests', label: 'Requests', icon: 'ClipboardList' },
  { module: 'approval', id: 'approvals', label: 'Approvals', icon: 'CheckCheck' },
  { module: 'assignment-ui', id: 'assignments', label: 'Assignments', icon: 'Boxes' },
  { module: 'consumption', id: 'consumption', label: 'Consumption', icon: 'Activity' },
  { module: 'returns', id: 'returns', label: 'Returns', icon: 'ArrowDownToLine' },
  { module: 'pcb-repair', id: 'repairs', label: 'Product Repairs', icon: 'Wrench' },
  { module: 'analytics', id: 'analytics', label: 'Analytics', icon: 'Activity' },
  { module: 'reports', id: 'reports', label: 'Reports & Excel', icon: 'FileSpreadsheet' },
]

function clone(value) { return structuredClone(value) }
function passwordHash() { return bcrypt.hashSync(process.env.DEMO_PASSWORD || 'Demo2026!', 10) }

export function createMemoryState() {
  const users = seedData.users.map((user) => ({ ...clone(user), passwordHash: passwordHash() }))
  const sites = seedData.sites.map((site) => ({ ...clone(site), config: { nodes: [], edges: [] }, updatedAt: new Date().toISOString() }))
  const releases = sites.map((site) => ({
    id: randomUUID(), siteId: site.siteId, version: 1, status: 'Published', actor: 'OpsHub Admin', createdAt: site.updatedAt,
    snapshot: { config: clone(site.config), modules: clone(site.modules), pages: clone(site.pages), theme: clone(site.theme) },
  }))
  return {
    users,
    sites,
    memberships: clone(seedData.memberships),
    locks: new Map(),
    inventory: clone(seedData.inventory),
    requests: clone(seedData.requests),
    approvals: [],
    assignments: clone(seedData.assignments),
    consumption: [],
    returns: [],
    repairs: [],
    releases,
  }
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 44) || 'new-site'
}

function objectFromSiteRow(row) {
  return {
    siteId: row.id, slug: row.slug, name: row.name, description: row.description, status: row.status,
    theme: row.theme, modules: row.modules, pages: row.pages, roles: row.roles, release: row.release,
    config: row.config, updatedAt: row.updated_at,
  }
}

async function recordsFor(ctx, resource) {
  if (ctx.client) {
    const result = await ctx.client.query('SELECT id, data FROM site_records WHERE site_id = $1 AND resource = $2 ORDER BY created_at DESC', [ctx.siteId, resource])
    return result.rows.map((row) => ({ ...row.data, id: row.id }))
  }
  return clone(ctx.state[resource].filter((record) => record.siteId === ctx.siteId))
}

async function insertRecord(ctx, resource, data) {
  const value = { ...data, id: data.id || randomUUID(), siteId: ctx.siteId }
  if (ctx.client) {
    await ctx.client.query('INSERT INTO site_records (id, site_id, resource, data) VALUES ($1, $2, $3, $4::jsonb)', [value.id, ctx.siteId, resource, JSON.stringify(value)])
  } else ctx.state[resource].push(clone(value))
  return value
}

async function updateRecord(ctx, resource, id, patch) {
  if (ctx.client) {
    const locked = await ctx.client.query('SELECT data FROM site_records WHERE site_id = $1 AND resource = $2 AND id = $3 FOR UPDATE', [ctx.siteId, resource, id])
    if (!locked.rowCount) throw httpError(404, 'Record not found in this site')
    const value = { ...locked.rows[0].data, ...patch, id, siteId: ctx.siteId }
    await ctx.client.query('UPDATE site_records SET data = $4::jsonb, updated_at = now() WHERE site_id = $1 AND resource = $2 AND id = $3', [ctx.siteId, resource, id, JSON.stringify(value)])
    return value
  }
  const record = ctx.state[resource].find((item) => item.siteId === ctx.siteId && item.id === id)
  if (!record) throw httpError(404, 'Record not found in this site')
  Object.assign(record, patch)
  return clone(record)
}

async function deleteRecord(ctx, resource, id) {
  if (ctx.client) {
    const result = await ctx.client.query('DELETE FROM site_records WHERE site_id=$1 AND resource=$2 AND id=$3 RETURNING id', [ctx.siteId, resource, id])
    return result.rowCount > 0
  }
  const index = ctx.state[resource].findIndex((item) => item.siteId === ctx.siteId && item.id === id)
  if (index < 0) return false
  ctx.state[resource].splice(index, 1)
  return true
}

async function lockRecord(ctx, resource, id) {
  if (ctx.client) {
    const result = await ctx.client.query('SELECT data FROM site_records WHERE site_id=$1 AND resource=$2 AND id=$3 FOR UPDATE', [ctx.siteId, resource, id])
    return result.rows[0] ? { ...result.rows[0].data, id, siteId: ctx.siteId } : null
  }
  const record = ctx.state[resource].find((item) => item.siteId === ctx.siteId && item.id === id)
  return record ? clone(record) : null
}

function withMemoryLock(state, key, work) {
  const previous = state.locks.get(key) ?? Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  state.locks.set(key, current)
  return previous.then(work).finally(() => {
    release()
    if (state.locks.get(key) === current) state.locks.delete(key)
  })
}

async function getSite(ctx) {
  if (ctx.client) {
    const result = await ctx.client.query('SELECT * FROM sites WHERE id = $1', [ctx.siteId])
    if (!result.rowCount) throw httpError(404, 'Site not found')
    return objectFromSiteRow(result.rows[0])
  }
  const site = ctx.state.sites.find((item) => item.siteId === ctx.siteId)
  if (!site) throw httpError(404, 'Site not found')
  return site
}

async function saveSite(ctx, site) {
  site.updatedAt = new Date().toISOString()
  if (ctx.client) {
    await ctx.client.query('UPDATE sites SET modules=$2, pages=$3::jsonb, theme=$4::jsonb, config=$5::jsonb, release=$6, status=$7, updated_at=now() WHERE id=$1', [ctx.siteId, site.modules, JSON.stringify(site.pages), JSON.stringify(site.theme), JSON.stringify(site.config), site.release, site.status])
  }
}

async function insertRelease(ctx, release) {
  if (ctx.client) {
    await ctx.client.query('INSERT INTO site_releases (id, site_id, version, status, actor, snapshot, created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)', [release.id, ctx.siteId, release.version, release.status, release.actor, JSON.stringify(release.snapshot), release.createdAt])
  } else ctx.state.releases.push(clone(release))
  return release
}

function siteMetrics(site, inventory, requests) {
  const items = inventory.filter((item) => item.siteId === site.siteId)
  const siteRequests = requests.filter((item) => item.siteId === site.siteId)
  return {
    stockValue: Math.round(items.reduce((sum, item) => sum + item.quantity * item.price, 0)),
    openRequests: siteRequests.filter((item) => item.status === 'Pending approval').length,
    lowStock: items.filter((item) => item.quantity <= item.reorderAt).length,
    completed: siteRequests.filter((item) => item.status === 'Assigned').length,
  }
}

async function withSite(user, siteId, minimumRole, work, state, database) {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw httpError(404, 'Site not found')
  if (!database) {
    const membership = state.memberships.find((item) => item.siteId === siteId && item.userId === user.id)
    if (!membership) throw httpError(403, 'You do not have access to this site')
    if ((roleRank[membership.role] ?? -1) < (roleRank[minimumRole] ?? 0)) throw httpError(403, 'Your site role cannot perform this action')
    return work({ siteId, role: membership.role, state })
  }
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('opshub.site_id', $1, true), set_config('opshub.user_id', $2, true)", [siteId, user.id])
    const membership = await client.query('SELECT role FROM site_memberships WHERE site_id = $1 AND user_id = $2', [siteId, user.id])
    if (!membership.rowCount) throw httpError(403, 'You do not have access to this site')
    const role = membership.rows[0].role
    if ((roleRank[role] ?? -1) < (roleRank[minimumRole] ?? 0)) throw httpError(403, 'Your site role cannot perform this action')
    const result = await work({ siteId, role, client })
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function listSites(user, state, database) {
  if (!database) {
    return state.memberships.filter((membership) => membership.userId === user.id).map((membership) => {
      const site = state.sites.find((item) => item.siteId === membership.siteId)
      if (!site) return null
      return { ...clone(site), role: membership.role, metrics: siteMetrics(site, state.inventory, state.requests) }
    }).filter(Boolean)
  }
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('opshub.user_id', $1, true)", [user.id])
    const memberships = await client.query('SELECT site_id, role FROM site_memberships WHERE user_id = $1 ORDER BY site_id', [user.id])
    const sites = []
    for (const membership of memberships.rows) {
      await client.query("SELECT set_config('opshub.site_id', $1, true)", [membership.site_id])
      const found = await client.query('SELECT * FROM sites WHERE id=$1', [membership.site_id])
      if (!found.rowCount) continue
      const site = objectFromSiteRow(found.rows[0])
      const items = await client.query("SELECT data FROM site_records WHERE site_id=$1 AND resource='inventory'", [site.siteId])
      const requests = await client.query("SELECT data FROM site_records WHERE site_id=$1 AND resource='requests'", [site.siteId])
      const inventoryData = items.rows.map((row) => row.data)
      const requestData = requests.rows.map((row) => row.data)
      sites.push({ ...site, role: membership.role, metrics: siteMetrics(site, inventoryData, requestData) })
    }
    await client.query('COMMIT')
    return sites
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function seedDatabase(database = pool, { reset = false } = {}) {
  if (!database) throw new Error('Set DATABASE_URL before running the PostgreSQL seed command')
  await database.query(await readFile(path.join(root, 'schema.sql'), 'utf8'))
  const demoPassword = process.env.DEMO_PASSWORD || 'Demo2026!'
  for (const user of seedData.users) {
    const hash = await bcrypt.hash(demoPassword, 10)
    await database.query('INSERT INTO users (id,name,email,phone,password_hash,global_role) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name,phone=COALESCE(EXCLUDED.phone,users.phone),password_hash=EXCLUDED.password_hash,global_role=EXCLUDED.global_role', [user.id, user.name, user.email, user.phone ?? null, hash, user.role])
  }
  const client = await database.connect()
  try {
    for (const site of seedData.sites) {
      await client.query('BEGIN')
      await client.query("SELECT set_config('opshub.site_id', $1, true)", [site.siteId])
      const exists = await client.query('SELECT id FROM sites WHERE id=$1', [site.siteId])
      if (!exists.rowCount || reset) {
        if (reset) {
          await client.query('DELETE FROM site_records WHERE site_id=$1', [site.siteId])
          await client.query('DELETE FROM site_releases WHERE site_id=$1', [site.siteId])
        }
        const config = { nodes: [], edges: [] }
        await client.query('INSERT INTO sites (id,slug,name,description,status,theme,modules,pages,roles,config,release) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10::jsonb,1) ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name,description=EXCLUDED.description,status=EXCLUDED.status,theme=EXCLUDED.theme,modules=EXCLUDED.modules,pages=EXCLUDED.pages,roles=EXCLUDED.roles', [site.siteId, site.slug, site.name, site.description, site.status, JSON.stringify(site.theme), site.modules, JSON.stringify(site.pages), site.roles, JSON.stringify(config)])
        for (const membership of seedData.memberships.filter((item) => item.siteId === site.siteId)) {
          await client.query('INSERT INTO site_memberships (site_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (site_id,user_id) DO UPDATE SET role=EXCLUDED.role', [membership.siteId, membership.userId, membership.role])
        }
        for (const resource of ['inventory', 'requests', 'assignments']) {
          for (const item of seedData[resource].filter((record) => record.siteId === site.siteId)) {
            await client.query('INSERT INTO site_records (id,site_id,resource,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO NOTHING', [item.id, site.siteId, resource, JSON.stringify(item)])
          }
        }
        const snapshot = { config, modules: site.modules, pages: site.pages, theme: site.theme }
        await client.query('INSERT INTO site_releases (site_id,version,status,actor,snapshot) VALUES ($1,1,$2,$3,$4::jsonb) ON CONFLICT (site_id,version) DO NOTHING', [site.siteId, 'Published', 'OpsHub Admin', JSON.stringify(snapshot)])
      } else if (site.slug === 'central-stores') {
        const current = await client.query('SELECT modules, pages FROM sites WHERE id=$1', [site.siteId])
        const modules = current.rows[0].modules ?? []
        const pages = current.rows[0].pages ?? []
        if (!modules.includes('request') || !pages.some((page) => page.id === 'requests')) {
          const requestPage = site.pages.find((page) => page.id === 'requests')
          await client.query('UPDATE sites SET modules=$2, pages=$3::jsonb WHERE id=$1', [site.siteId, modules.includes('request') ? modules : [...modules, 'request'], JSON.stringify(pages.some((page) => page.id === 'requests') ? pages : [...pages, requestPage])])
        }
      } else if (site.slug === 'distribution') {
        const existingInventory = await client.query("SELECT data->>'sku' AS sku FROM site_records WHERE site_id=$1 AND resource='inventory'", [site.siteId])
        const existingSkus = new Set(existingInventory.rows.map((row) => String(row.sku).toLowerCase()))
        for (const item of seedData.inventory.filter((record) => record.siteId === site.siteId && !existingSkus.has(record.sku.toLowerCase()))) {
          await client.query('INSERT INTO site_records (id,site_id,resource,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO NOTHING', [item.id, site.siteId, 'inventory', JSON.stringify(item)])
        }
      }
      await client.query('COMMIT')
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export function createApp({ state = createMemoryState(), database = pool, minimoth = minimothClient } = {}) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '2mb' }))
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
  const otpSendAttempts = new Map()
  const otpVerifyAttempts = new Map()
  function enforcePhoneLimit(store, phone, limit) {
    const now = Date.now()
    const recent = (store.get(phone) ?? []).filter((timestamp) => now - timestamp < 10 * 60 * 1000)
    if (recent.length >= limit) throw httpError(429, 'Too many OTP attempts. Try again later.')
    recent.push(now)
    store.set(phone, recent)
    if (store.size > 5000) for (const [key, attempts] of store) if (!attempts.some((timestamp) => now - timestamp < 10 * 60 * 1000)) store.delete(key)
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true, storage: database ? 'postgres' : 'offline-demo', minimothOtp: Boolean(minimoth) }))
  app.get('/api/auth/methods', (_req, res) => res.json({ password: true, minimothOtp: Boolean(minimoth) }))
  app.post('/api/auth/login', wrap(async (req, res) => {
    const email = String(req.body?.email ?? '').toLowerCase().trim()
    const password = String(req.body?.password ?? '')
    let user
    if (database) {
      const result = await database.query('SELECT id,name,email,password_hash,global_role FROM users WHERE lower(email)=lower($1)', [email])
      user = result.rows[0] && { id: result.rows[0].id, name: result.rows[0].name, email: result.rows[0].email, passwordHash: result.rows[0].password_hash, role: result.rows[0].global_role }
    } else user = state.users.find((item) => item.email.toLowerCase() === email)
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw httpError(401, 'Email or password is incorrect')
    const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: '8h' })
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
  }))
  app.post('/api/auth/otp/send', wrap(async (req, res) => {
    if (!minimoth) throw httpError(503, 'Phone sign-in is not configured. Set MINIMOTH_API_KEY on the server.')
    const { phone } = parseInput(otpSendInput, req.body ?? {})
    enforcePhoneLimit(otpSendAttempts, phone, 3)
    const known = database
      ? (await database.query('SELECT id FROM users WHERE phone=$1', [phone])).rowCount > 0
      : state.users.some((user) => user.phone === phone)
    if (!known) throw httpError(404, 'No OpsHub account is enrolled for that phone number. Ask an Admin to add it under Team & access.')
    try {
      const result = await minimoth.otp.send({ phone })
      res.json({ otpId: result.otpId })
    } catch (error) {
      if (error instanceof MiniMothError) throw httpError(error.statusCode || 502, `MiniMoth: ${error.code}`)
      throw error
    }
  }))
  app.post('/api/auth/otp/verify', wrap(async (req, res) => {
    if (!minimoth) throw httpError(503, 'Phone sign-in is not configured. Set MINIMOTH_API_KEY on the server.')
    const { phone, otp } = parseInput(otpVerifyInput, req.body ?? {})
    enforcePhoneLimit(otpVerifyAttempts, phone, 5)
    try {
      const result = await minimoth.otp.verify({ phone, otp })
      if (!result.valid) throw httpError(401, result.code || 'OTP is invalid or expired')
      let user
      if (database) {
        const found = await database.query('SELECT id,name,email,global_role FROM users WHERE phone=$1', [phone])
        user = found.rows[0] && { id: found.rows[0].id, name: found.rows[0].name, email: found.rows[0].email, role: found.rows[0].global_role }
      } else {
        const found = state.users.find((item) => item.phone === phone)
        user = found && { id: found.id, name: found.name, email: found.email, role: found.role }
      }
      if (!user) throw httpError(403, 'Verified phone is not linked to an OpsHub account')
      const token = jwt.sign({ sub: user.id, role: user.role, auth: 'minimoth-otp' }, jwtSecret, { expiresIn: '8h' })
      res.json({ token, user })
    } catch (error) {
      if (error instanceof MiniMothError) throw httpError(error.statusCode || 502, `MiniMoth: ${error.code}`)
      throw error
    }
  }))
  app.use('/api', wrap(async (req, _res, next) => {
    if (req.path === '/health' || req.path === '/auth/login') return next()
    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) throw httpError(401, 'Sign in is required')
    try { req.user = jwt.verify(header.slice(7), jwtSecret) }
    catch { throw httpError(401, 'Session expired. Sign in again.') }
    if (database) {
      const result = await database.query('SELECT id,name,email,global_role FROM users WHERE id=$1', [req.user.sub])
      if (!result.rowCount) throw httpError(401, 'Account no longer exists')
      req.authUser = { id: result.rows[0].id, name: result.rows[0].name, email: result.rows[0].email, role: result.rows[0].global_role }
    } else {
      const user = state.users.find((item) => item.id === req.user.sub)
      req.authUser = user && { id: user.id, name: user.name, email: user.email, role: user.role }
    }
    if (!req.authUser) throw httpError(401, 'Account no longer exists')
    next()
  }))

  app.get('/api/session', wrap(async (req, res) => res.json({ user: req.authUser, sites: await listSites(req.authUser, state, database) })))
  app.get('/api/sites', wrap(async (req, res) => res.json({ sites: await listSites(req.authUser, state, database) })))
  app.post('/api/sites', wrap(async (req, res) => {
    if (req.authUser.role !== 'Admin') throw httpError(403, 'Only an Admin can create sites')
    const { name } = parseInput(siteInput, req.body ?? {})
    const slugBase = slugify(name)
    const site = {
      siteId: randomUUID(), slug: slugBase, name, description: 'A new operations workspace.', status: 'Draft',
      theme: { accent: '#397a68', canvas: '#f5f4ef', ink: '#234b40', label: 'Fern' },
      modules: ['auth', 'users', 'shell', 'inventory', 'analytics', 'reports'], pages: defaultPages.filter((page) => ['inventory', 'analytics', 'reports'].includes(page.id)),
      roles: ['Public', 'Member', 'Manager', 'Admin'], config: { nodes: [], edges: [] }, release: 0, updatedAt: new Date().toISOString(),
    }
    if (database) {
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('opshub.site_id', $1, true)", [site.siteId])
        await client.query('INSERT INTO sites (id,slug,name,description,status,theme,modules,pages,roles,config,release) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10::jsonb,0)', [site.siteId, site.slug, site.name, site.description, site.status, JSON.stringify(site.theme), site.modules, JSON.stringify(site.pages), site.roles, JSON.stringify(site.config)])
        await client.query("INSERT INTO site_memberships (site_id,user_id,role) VALUES ($1,$2,'Admin')", [site.siteId, req.authUser.id])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally { client.release() }
    } else {
      if (state.sites.some((item) => item.slug === site.slug)) site.slug = `${site.slug}-${state.sites.length + 1}`
      state.sites.push(site); state.memberships.push({ siteId: site.siteId, userId: req.authUser.id, role: 'Admin' })
    }
    res.status(201).json({ site: { ...site, metrics: { stockValue: 0, openRequests: 0, lowStock: 0, completed: 0 } } })
  }))

  app.get('/api/users', wrap(async (req, res) => {
    if (req.authUser.role !== 'Admin') throw httpError(403, 'Only an Admin can manage users')
    if (!database) return res.json({ users: state.users.map(({ passwordHash: _hash, ...user }) => user) })
    const users = await database.query('SELECT id,name,email,phone,global_role AS role FROM users ORDER BY name')
    res.json({ users: users.rows })
  }))
  app.post('/api/users', wrap(async (req, res) => {
    if (req.authUser.role !== 'Admin') throw httpError(403, 'Only an Admin can manage users')
    const { name, email, password, phone, siteId, role } = parseInput(globalUserInput, req.body ?? {})
    const id = randomUUID(); const hash = await bcrypt.hash(password, 10)
    if (database) {
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('opshub.site_id', $1, true)", [siteId])
        await client.query('INSERT INTO users (id,name,email,phone,password_hash,global_role) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, email.toLowerCase(), phone ?? null, hash, role])
        await client.query('INSERT INTO site_memberships (site_id,user_id,role) VALUES ($1,$2,$3)', [siteId, id, role])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally { client.release() }
    } else {
      if (state.users.some((item) => item.email.toLowerCase() === String(email).toLowerCase())) throw httpError(409, 'That email is already registered')
      if (!state.sites.some((item) => item.siteId === siteId)) throw httpError(404, 'Site not found')
      state.users.push({ id, name, email: email.toLowerCase(), phone, role, passwordHash: hash })
      state.memberships.push({ siteId, userId: id, role })
    }
    res.status(201).json({ user: { id, name, email: email.toLowerCase(), phone: phone ?? null, role, siteId } })
  }))

  app.get('/api/:siteId/users', wrap(async (req, res) => {
    const users = await withSite(req.authUser, req.params.siteId, 'Manager', async (ctx) => {
      if (ctx.client) {
        const result = await ctx.client.query('SELECT u.id,u.name,u.email,u.phone,m.role FROM site_memberships m JOIN users u ON u.id=m.user_id WHERE m.site_id=$1 ORDER BY u.name', [ctx.siteId])
        return result.rows
      }
      return ctx.state.memberships.filter((item) => item.siteId === ctx.siteId).map((membership) => {
        const { passwordHash: _hash, ...member } = ctx.state.users.find((item) => item.id === membership.userId) ?? {}
        return { ...member, role: membership.role }
      }).filter((item) => item.id)
    }, state, database)
    res.json({ users })
  }))
  app.post('/api/:siteId/users', wrap(async (req, res) => {
    const { name, email, password, phone, role } = parseInput(siteUserInput, req.body ?? {})
    const hash = await bcrypt.hash(password, 10)
    const user = await withSite(req.authUser, req.params.siteId, 'Manager', async (ctx) => {
      if ((roleRank[role] ?? 0) > roleRank[ctx.role]) throw httpError(403, 'You cannot assign a role higher than your own')
      const id = randomUUID()
      if (ctx.client) {
        await ctx.client.query('INSERT INTO users (id,name,email,phone,password_hash,global_role) VALUES ($1,$2,$3,$4,$5,$6)', [id, String(name).trim(), String(email).toLowerCase(), phone ?? null, hash, 'Member'])
        await ctx.client.query('INSERT INTO site_memberships (site_id,user_id,role) VALUES ($1,$2,$3)', [ctx.siteId, id, role])
      } else {
        if (ctx.state.users.some((item) => item.email.toLowerCase() === String(email).toLowerCase())) throw httpError(409, 'That email is already registered')
        ctx.state.users.push({ id, name: String(name).trim(), email: String(email).toLowerCase(), phone, role: 'Member', passwordHash: hash })
        ctx.state.memberships.push({ siteId: ctx.siteId, userId: id, role })
      }
      return { id, name: String(name).trim(), email: String(email).toLowerCase(), phone: phone ?? null, role, siteId: ctx.siteId }
    }, state, database)
    res.status(201).json({ user })
  }))

  app.get('/api/:siteId/:resource', wrap(async (req, res) => {
    const { siteId, resource } = req.params
    if (resource === 'components') {
      const config = await withSite(req.authUser, siteId, 'Public', async (ctx) => (await getSite(ctx)).config, state, database)
      return res.json({ config })
    }
    if (resource === 'releases') {
      const releases = await withSite(req.authUser, siteId, 'Public', async (ctx) => {
        if (ctx.client) {
          const result = await ctx.client.query('SELECT id,version,status,actor,created_at AS "createdAt" FROM site_releases WHERE site_id=$1 ORDER BY version DESC', [siteId])
          return result.rows
        }
        return ctx.state.releases.filter((item) => item.siteId === siteId).sort((a, b) => b.version - a.version).map(({ snapshot: _snapshot, siteId: _siteId, ...item }) => item)
      }, state, database)
      return res.json({ releases })
    }
    if (!['inventory', 'requests', 'approvals', 'assignments', 'consumption', 'returns', 'repairs'].includes(resource)) throw httpError(404, 'Unknown site resource')
    const result = await withSite(req.authUser, siteId, 'Public', async (ctx) => {
      let records = resource === 'approvals' ? await recordsFor(ctx, 'approvals') : await recordsFor(ctx, resource)
      if (resource === 'requests' && (await getSite(ctx)).slug === 'central-stores') {
        const distributionId = seedData.sites.find((site) => site.slug === 'distribution')?.siteId
        if (distributionId) {
          if (ctx.client) await ctx.client.query("SELECT set_config('opshub.site_id', $1, true)", [distributionId])
          const distributionCtx = { ...ctx, siteId: distributionId }
          const routed = ctx.client
            ? await recordsFor(distributionCtx, 'requests')
            : ctx.state.requests.filter((request) => request.siteId === distributionId)
          records = [...records, ...routed.filter((request) => request.sourceSiteId === ctx.siteId)]
          if (ctx.client) await ctx.client.query("SELECT set_config('opshub.site_id', $1, true)", [ctx.siteId])
        }
      }
      return { [resource]: records }
    }, state, database)
    res.json(result)
  }))

  app.post('/api/:siteId/components', wrap(async (req, res) => {
    const result = await withSite(req.authUser, req.params.siteId, 'Admin', async (ctx) => {
      const parsed = parseInput(componentInput, req.body ?? {})
      const nodes = parsed.nodes
      const edges = parsed.edges
      const modules = [...new Set(parsed.modules)]
      if (modules.some((module) => !allowedModules.has(module))) throw httpError(400, 'Configuration contains an unapproved module')
      const nodeMap = new Map(nodes.map((node) => [node.id, node]))
      if (nodeMap.size !== nodes.length) throw httpError(400, 'Module node IDs must be unique')
      const nodeModules = [...new Set(nodes.map((node) => node.data.moduleId))].sort()
      if (JSON.stringify(nodeModules) !== JSON.stringify([...modules].sort())) throw httpError(400, 'Module list must match the modules present on the canvas')
      for (const node of nodes) {
        const ports = modulePorts[node.data.moduleId]
        if (!ports || JSON.stringify(node.data.inputs) !== JSON.stringify(ports.inputs) || JSON.stringify(node.data.outputs) !== JSON.stringify(ports.outputs)) throw httpError(400, `Node ports do not match the approved ${node.data.moduleId} module contract`)
      }
      for (const edge of edges) {
        const source = nodeMap.get(edge.source); const target = nodeMap.get(edge.target)
        const output = String(edge.sourceHandle ?? '').replace('out:', '')
        const input = String(edge.targetHandle ?? '').replace('in:', '')
        if (!source || !target || !output || output !== input || !source.data?.outputs?.includes(output) || !target.data?.inputs?.includes(input)) throw httpError(400, 'Workflow connection uses incompatible input/output types')
      }
      for (const node of nodes) for (const required of requiredModuleInputs[node.data.moduleId] ?? []) {
        if (!edges.some((edge) => edge.target === node.id && edge.targetHandle === `in:${required}`)) throw httpError(400, `${node.data.moduleId} requires a connected ${required} input`)
      }
      const site = await getSite(ctx)
      site.modules = modules
      site.pages = defaultPages.filter((page) => modules.includes(page.module))
      site.config = { nodes, edges }
      await saveSite(ctx, site)
      return { config: site.config, modules: site.modules, pages: site.pages }
    }, state, database)
    res.json(result)
  }))

  app.post('/api/:siteId/requests', wrap(async (req, res) => {
    const created = await withSite(req.authUser, req.params.siteId, 'Member', async (ctx) => {
      const { title, quantity, itemId, priority } = parseInput(requestInput, req.body ?? {})
      const item = (await recordsFor(ctx, 'inventory')).find((record) => record.id === itemId)
      if (!item) throw httpError(404, 'Selected item is not in this site inventory')
      const sourceSite = await getSite(ctx)
      if (sourceSite.slug === 'central-stores') {
        const distribution = seedData.sites.find((site) => site.slug === 'distribution')
        if (!distribution) throw httpError(503, 'Distribution site is not configured')
        if (ctx.client) await ctx.client.query("SELECT set_config('opshub.site_id', $1, true)", [distribution.siteId])
        const distributionCtx = { ...ctx, siteId: distribution.siteId }
        const normalizeSku = (sku) => String(sku).toLowerCase().replace(/^(ph|ds)-/, '')
        const normalizedSourceSku = normalizeSku(item.sku)
        const distributionItem = (await recordsFor(distributionCtx, 'inventory')).find((record) => normalizeSku(record.sku) === normalizedSourceSku || record.name.trim().toLowerCase() === item.name.trim().toLowerCase())
        if (!distributionItem) throw httpError(404, `Distribution does not stock ${item.name}`)
        if (quantity > distributionItem.quantity) throw httpError(409, `Only ${distributionItem.quantity} units are available at Distribution`)
        const routed = await insertRecord(distributionCtx, 'requests', { title, requester: req.authUser.name, itemId: distributionItem.id, itemName: distributionItem.name, sourceItemName: item.name, sourceSiteId: ctx.siteId, sourceSiteName: sourceSite.name, sourceSiteSlug: sourceSite.slug, quantity, status: 'Pending approval', priority, createdAt: new Date().toISOString() })
        if (ctx.client) await ctx.client.query("SELECT set_config('opshub.site_id', $1, true)", [ctx.siteId])
        return routed
      }
      if (quantity > item.quantity) throw httpError(409, 'Requested quantity exceeds available stock')
      return insertRecord(ctx, 'requests', { title, requester: req.authUser.name, itemId: item.id, itemName: item.name, quantity, status: 'Pending approval', priority, createdAt: new Date().toISOString() })
    }, state, database)
    res.status(201).json({ request: created })
  }))

  app.post('/api/:siteId/inventory', wrap(async (req, res) => {
    const created = await withSite(req.authUser, req.params.siteId, 'Manager', async (ctx) => {
      const { name, sku, category, quantity, reorderAt, unit, price, location } = parseInput(inventoryInput, req.body ?? {})
      const current = await recordsFor(ctx, 'inventory')
      if (current.some((item) => item.sku.toLowerCase() === String(sku).toLowerCase())) throw httpError(409, 'SKU already exists in this site')
      return insertRecord(ctx, 'inventory', { name, sku: sku.toUpperCase(), category, quantity, reorderAt, unit, price, location })
    }, state, database)
    res.status(201).json({ item: created })
  }))

  app.patch('/api/:siteId/inventory/:itemId', wrap(async (req, res) => {
    const item = await withSite(req.authUser, req.params.siteId, 'Manager', async (ctx) => {
      const patch = parseInput(inventoryPatch, req.body ?? {})
      const existing = await lockRecord(ctx, 'inventory', req.params.itemId)
      if (!existing) throw httpError(404, 'Inventory item not found in this site')
      const nextSku = patch.sku?.toLowerCase()
      if (nextSku && (await recordsFor(ctx, 'inventory')).some((record) => record.id !== existing.id && record.sku.toLowerCase() === nextSku)) throw httpError(409, 'SKU already exists in this site')
      if (patch.sku) patch.sku = patch.sku.toUpperCase()
      return updateRecord(ctx, 'inventory', existing.id, patch)
    }, state, database)
    res.json({ item })
  }))

  app.delete('/api/:siteId/inventory/:itemId', wrap(async (req, res) => {
    const deleted = await withSite(req.authUser, req.params.siteId, 'Manager', async (ctx) => {
      const existing = await lockRecord(ctx, 'inventory', req.params.itemId)
      if (!existing) throw httpError(404, 'Inventory item not found in this site')
      const [requests, assignments] = await Promise.all([recordsFor(ctx, 'requests'), recordsFor(ctx, 'assignments')])
      if (requests.some((record) => record.itemId === existing.id) || assignments.some((record) => record.itemId === existing.id)) throw httpError(409, 'This item is referenced by site workflow history and cannot be deleted')
      if (!await deleteRecord(ctx, 'inventory', existing.id)) throw httpError(404, 'Inventory item not found in this site')
      return true
    }, state, database)
    res.json({ deleted })
  }))

  app.post('/api/:siteId/approvals', wrap(async (req, res) => {
    const input = parseInput(approvalInput, req.body ?? {})
    const result = await withSite(req.authUser, req.params.siteId, 'Manager', async (ctx) => {
      const processApproval = async () => {
      const request = await lockRecord(ctx, 'requests', input.requestId)
      if (!request) throw httpError(404, 'Request not found in this site')
      if (request.status !== 'Pending approval') throw httpError(409, 'Request has already been decided')
      const decision = input.decision === 'reject' ? 'Rejected' : 'Approved'
      if (decision === 'Rejected') {
        const updated = await updateRecord(ctx, 'requests', request.id, { status: 'Rejected' })
        const approval = await insertRecord(ctx, 'approvals', { requestId: request.id, decision: 'Rejected', actor: req.authUser.name, comment: input.comment, createdAt: new Date().toISOString() })
        return { request: updated, approval, assignment: null }
      }
      const item = await lockRecord(ctx, 'inventory', request.itemId)
      if (!item) throw httpError(404, 'Requested stock item is no longer available')
      if (item.quantity < request.quantity) throw httpError(409, 'Insufficient stock. No approval or assignment was recorded.')
      const updatedItem = await updateRecord(ctx, 'inventory', item.id, { quantity: item.quantity - request.quantity })
      const updatedRequest = await updateRecord(ctx, 'requests', request.id, { status: 'Assigned' })
      const approval = await insertRecord(ctx, 'approvals', { requestId: request.id, decision, actor: req.authUser.name, comment: input.comment, createdAt: new Date().toISOString() })
      const assignment = await insertRecord(ctx, 'assignments', { requestId: request.id, itemId: item.id, itemName: item.name, quantity: request.quantity, assignee: request.requester, status: 'Issued', createdAt: new Date().toISOString() })
      return { request: updatedRequest, item: updatedItem, approval, assignment }
      }
      return ctx.client ? processApproval() : withMemoryLock(ctx.state, `approval:${ctx.siteId}`, processApproval)
    }, state, database)
    res.json(result)
  }))

  for (const resource of ['consumption', 'returns']) {
    app.post(`/api/:siteId/${resource}`, wrap(async (req, res) => {
      const input = parseInput(logInput, req.body ?? {})
      const record = await withSite(req.authUser, req.params.siteId, 'Member', async (ctx) => {
        const recordOperation = async () => {
          const assignment = await lockRecord(ctx, 'assignments', input.assignmentId)
          if (!assignment || assignment.status !== 'Issued') throw httpError(404, 'Issued assignment not found in this site')
          const [consumptionRows, returnRows] = await Promise.all([recordsFor(ctx, 'consumption'), recordsFor(ctx, 'returns')])
          const consumed = consumptionRows.filter((row) => row.assignmentId === assignment.id).reduce((sum, row) => sum + row.quantity, 0)
          const returned = returnRows.filter((row) => row.assignmentId === assignment.id).reduce((sum, row) => sum + row.quantity, 0)
          const remaining = assignment.quantity - consumed - returned
          if (input.quantity > remaining) throw httpError(409, `Quantity exceeds the ${remaining} units remaining on this assignment`)
          if (resource === 'consumption') return insertRecord(ctx, resource, { ...input, actor: req.authUser.name, createdAt: new Date().toISOString() })
          const item = await lockRecord(ctx, 'inventory', assignment.itemId)
          if (!item) throw httpError(404, 'Assigned inventory item no longer exists')
          const restocked = input.condition === 'Unused' || input.condition === 'Good'
          if (restocked) await updateRecord(ctx, 'inventory', item.id, { quantity: item.quantity + input.quantity })
          return insertRecord(ctx, resource, { ...input, restocked, actor: req.authUser.name, createdAt: new Date().toISOString() })
        }
        return ctx.client ? recordOperation() : withMemoryLock(ctx.state, `assignment:${ctx.siteId}:${input.assignmentId}`, recordOperation)
      }, state, database)
      res.status(201).json({ [resource]: record })
    }))
  }

  app.post('/api/:siteId/repairs', wrap(async (req, res) => {
    const input = parseInput(repairInput, req.body ?? {})
    const repair = await withSite(req.authUser, req.params.siteId, 'Member', async (ctx) => {
      if (input.requestId && !(await recordsFor(ctx, 'requests')).some((request) => request.id === input.requestId)) throw httpError(404, 'Linked request not found in this site')
      return insertRecord(ctx, 'repairs', { ...input, status: 'Received', actor: req.authUser.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    }, state, database)
    res.status(201).json({ repair })
  }))

  app.patch('/api/:siteId/repairs/:repairId', wrap(async (req, res) => {
    const { status } = parseInput(repairStatusInput, req.body ?? {})
    const repair = await withSite(req.authUser, req.params.siteId, 'Member', async (ctx) => {
      const existing = await lockRecord(ctx, 'repairs', req.params.repairId)
      if (!existing) throw httpError(404, 'Repair record not found in this site')
      const order = ['Received', 'Diagnosing', 'In repair', 'Ready for pickup', 'Completed']
      if (order.indexOf(status) < order.indexOf(existing.status ?? 'Received')) throw httpError(409, 'Repair progress cannot move backwards')
      const updated = await updateRecord(ctx, 'repairs', existing.id, { status, updatedAt: new Date().toISOString(), actor: req.authUser.name })
      if (existing.requestId) {
        const request = await lockRecord(ctx, 'requests', existing.requestId)
        if (request) await updateRecord(ctx, 'requests', request.id, { serviceStatus: status, updatedAt: new Date().toISOString() })
      }
      return updated
    }, state, database)
    res.json({ repair })
  }))

  app.post('/api/:siteId/releases', wrap(async (req, res) => {
    const release = await withSite(req.authUser, req.params.siteId, 'Admin', async (ctx) => {
      const site = await getSite(ctx)
      if (site.release === 0) site.status = 'Live'
      site.release += 1
      await saveSite(ctx, site)
      const created = { id: randomUUID(), siteId: ctx.siteId, version: site.release, status: String(req.body?.status ?? 'Published'), actor: req.authUser.name, snapshot: { config: clone(site.config), modules: clone(site.modules), pages: clone(site.pages), theme: clone(site.theme) }, createdAt: new Date().toISOString() }
      await insertRelease(ctx, created)
      const { snapshot: _snapshot, siteId: _siteId, ...publicRelease } = created
      return publicRelease
    }, state, database)
    res.status(201).json({ release })
  }))

  app.post('/api/:siteId/releases/:releaseId/rollback', wrap(async (req, res) => {
    const result = await withSite(req.authUser, req.params.siteId, 'Admin', async (ctx) => {
      let source
      if (ctx.client) {
        const found = await ctx.client.query('SELECT * FROM site_releases WHERE site_id=$1 AND id=$2', [ctx.siteId, req.params.releaseId])
        source = found.rows[0] && { ...found.rows[0].snapshot, version: found.rows[0].version }
      } else source = ctx.state.releases.find((item) => item.siteId === ctx.siteId && item.id === req.params.releaseId)?.snapshot
      if (!source) throw httpError(404, 'Release not found in this site')
      const site = await getSite(ctx)
      site.config = clone(source.config); site.modules = clone(source.modules); site.pages = clone(source.pages); site.theme = clone(source.theme); site.status = 'Live'; site.release += 1
      await saveSite(ctx, site)
      const created = { id: randomUUID(), siteId: ctx.siteId, version: site.release, status: `Rollback to v${source.version ?? 1}`, actor: req.authUser.name, snapshot: clone(source), createdAt: new Date().toISOString() }
      await insertRelease(ctx, created)
      return { site, version: created.version }
    }, state, database)
    res.json(result)
  }))

  app.get('/api/:siteId/reports/export.xlsx', wrap(async (req, res) => {
    const buffer = await withSite(req.authUser, req.params.siteId, 'Manager', async (ctx) => {
      const [inventory, requests, assignments] = await Promise.all([recordsFor(ctx, 'inventory'), recordsFor(ctx, 'requests'), recordsFor(ctx, 'assignments')])
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'OpsHub One'; workbook.created = new Date()
      const stockSheet = workbook.addWorksheet('Inventory')
      stockSheet.columns = [{ header: 'SKU', key: 'sku', width: 16 }, { header: 'Item', key: 'name', width: 28 }, { header: 'Category', key: 'category', width: 18 }, { header: 'Quantity', key: 'quantity', width: 12 }, { header: 'Reorder at', key: 'reorderAt', width: 12 }, { header: 'Unit price', key: 'price', width: 14 }, { header: 'Stock value', key: 'value', width: 15 }, { header: 'Location', key: 'location', width: 28 }]
      inventory.forEach((item) => stockSheet.addRow({ ...item, value: item.quantity * item.price }))
      const requestSheet = workbook.addWorksheet('Requests')
      requestSheet.columns = [{ header: 'Title', key: 'title', width: 32 }, { header: 'Requester', key: 'requester', width: 22 }, { header: 'Item', key: 'itemName', width: 24 }, { header: 'Quantity', key: 'quantity', width: 12 }, { header: 'Status', key: 'status', width: 20 }, { header: 'Priority', key: 'priority', width: 12 }, { header: 'Created', key: 'createdAt', width: 24 }]
      requests.forEach((item) => requestSheet.addRow(item))
      const assignmentSheet = workbook.addWorksheet('Assignments')
      assignmentSheet.columns = [{ header: 'Item', key: 'itemName', width: 26 }, { header: 'Quantity', key: 'quantity', width: 12 }, { header: 'Assignee', key: 'assignee', width: 22 }, { header: 'Status', key: 'status', width: 15 }, { header: 'Created', key: 'createdAt', width: 24 }]
      assignments.forEach((item) => assignmentSheet.addRow(item))
      for (const sheet of workbook.worksheets) { sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF235A4B' } }; sheet.views = [{ state: 'frozen', ySplit: 1 }] }
      return Buffer.from(await workbook.xlsx.writeBuffer())
    }, state, database)
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`${req.params.siteId}-operations.xlsx`).send(buffer)
  }))

  app.post('/api/:siteId/reports/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, 'Upload an Excel workbook')
    const result = await withSite(req.authUser, req.params.siteId, 'Manager', async (ctx) => {
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(req.file.buffer)
      const sheet = workbook.getWorksheet('Inventory') ?? workbook.worksheets[0]
      if (!sheet) throw httpError(400, 'Workbook has no worksheet')
      const headers = sheet.getRow(1).values.slice(1).map((value) => String(value ?? '').trim().toLowerCase())
      const index = (name) => headers.indexOf(name) + 1
      if (index('sku') < 0 || index('item') < 0 || index('quantity') < 0) throw httpError(400, 'Inventory sheet requires SKU, Item, and Quantity columns')
      let imported = 0
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber)
        const get = (name) => row.getCell(index(name)).value
        const name = String(get('item') ?? '').trim(); const sku = String(get('sku') ?? '').trim().toUpperCase(); const quantity = Number(get('quantity'))
        if (!name && !sku) continue
        if (!name || !sku || !Number.isInteger(quantity) || quantity < 0) throw httpError(400, `Invalid inventory row ${rowNumber}`)
        const item = { name, sku, quantity, category: String(get('category') ?? 'Imported'), reorderAt: Number(get('reorder at') ?? 5), unit: 'units', price: Number(get('unit price') ?? 0), location: String(get('location') ?? 'Import') }
        const current = await recordsFor(ctx, 'inventory')
        const existing = current.find((entry) => entry.sku.toLowerCase() === sku.toLowerCase())
        if (existing) await updateRecord(ctx, 'inventory', existing.id, item)
        else await insertRecord(ctx, 'inventory', item)
        imported++
      }
      return { imported }
    }, state, database)
    res.json(result)
  }))

  app.use((error, _req, res, _next) => {
    const status = Number(error.status) || (error.code === '23505' ? 409 : 500)
    if (status >= 500 && !error.status) console.error(error)
    res.status(status).json({ error: status === 500 ? 'Unexpected server error' : error.message })
  })
  return app
}

export let app = createApp()

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let storage = pool ? 'PostgreSQL' : 'offline demo storage'
  if (pool) {
    try {
      await seedDatabase(pool)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown'
      console.error(`PostgreSQL startup failed (${code}); using temporary offline demo storage.`)
      await pool.end().catch(() => undefined)
      storage = 'offline demo storage'
      app = createApp({ database: null })
    }
  }
  const port = Number(process.env.PORT || 4000)
  app.listen(port, () => console.log(`OpsHub API listening on http://localhost:${port} (${storage})`))
}

function parseInput(schema, payload) {
  const result = schema.safeParse(payload)
  if (!result.success) throw httpError(400, result.error.issues[0]?.message ?? 'Invalid request body')
  return result.data
}
