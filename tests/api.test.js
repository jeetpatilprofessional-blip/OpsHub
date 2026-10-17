import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import ExcelJS from 'exceljs'
import request from 'supertest'
import { createApp, createMemoryState } from '../server/index.js'

const centralId = '10000000-0000-4000-8000-000000000001'
const serviceId = '10000000-0000-4000-8000-000000000002'
const distributionId = '10000000-0000-4000-8000-000000000003'
const modulePorts = {
  auth: [[], ['Session']], users: [['Session'], ['Member']], inventory: [['Session'], ['StockItem']],
  request: [['Member', 'StockItem'], ['Request']], approval: [['Request'], ['ApprovedRequest']],
  'material-assignment': [['ApprovedRequest', 'StockItem'], ['Assignment']],
}
function graphFor(modules, connections = []) {
  const nodes = modules.map((moduleId) => ({ id: moduleId, type: 'moduleNode', position: { x: 0, y: 0 }, data: { moduleId, inputs: modulePorts[moduleId][0], outputs: modulePorts[moduleId][1] } }))
  const edges = connections.map(([source, target, type]) => ({ id: `${source}-${target}-${type}`, source, target, sourceHandle: `out:${type}`, targetHandle: `in:${type}` }))
  return { nodes, edges, modules }
}

describe('OpsHub tenant APIs', () => {
  let app
  let state
  let adminToken
  let memberToken

  beforeEach(async () => {
    state = createMemoryState()
    app = createApp({ state, database: null })
    const admin = await request(app).post('/api/auth/login').send({ email: 'admin@opshub.local', password: 'Demo2026!' })
    const member = await request(app).post('/api/auth/login').send({ email: 'sam@opshub.local', password: 'Demo2026!' })
    adminToken = admin.body.token
    memberToken = member.body.token
    assert.ok(adminToken)
    assert.ok(memberToken)
  })

  test('returns only records belonging to the requested site', async () => {
    const central = await request(app).get(`/api/${centralId}/inventory`).set('Authorization', `Bearer ${adminToken}`).expect(200)
    const service = await request(app).get(`/api/${serviceId}/inventory`).set('Authorization', `Bearer ${adminToken}`).expect(200)
    const distribution = await request(app).get(`/api/${distributionId}/inventory`).set('Authorization', `Bearer ${adminToken}`).expect(200)
    assert.ok(central.body.inventory.some((item) => item.sku === 'PH-APL-16-128'))
    assert.ok(!service.body.inventory.some((item) => item.sku === 'PH-APL-16-128'))
    assert.ok(service.body.inventory.some((item) => item.sku === 'SR-APL-IP15-BAT'))
    assert.ok(!distribution.body.inventory.some((item) => item.sku === 'SR-APL-IP15-BAT'))
    assert.ok(distribution.body.inventory.every((item) => item.siteId === distributionId))
  })

  test('membership and role checks reject an inaccessible site and manager action', async () => {
    await request(app).get(`/api/${serviceId}/inventory`).set('Authorization', `Bearer ${memberToken}`).expect(403)
    await request(app).post(`/api/${centralId}/inventory`).set('Authorization', `Bearer ${memberToken}`).send({ name: 'Restricted part', sku: 'X-1', quantity: 3, price: 2 }).expect(403)
    const sites = await request(app).get('/api/sites').set('Authorization', `Bearer ${memberToken}`).expect(200)
    assert.deepEqual(sites.body.sites.map((site) => site.slug).sort(), ['central-stores', 'distribution'])
  })

  test('session never exposes password hashes and site roles grant scoped access', async () => {
    const session = await request(app).get('/api/session').set('Authorization', `Bearer ${adminToken}`).expect(200)
    assert.equal('passwordHash' in session.body.user, false)
    const login = await request(app).post('/api/auth/login').send({ email: 'manager@opshub.local', password: 'Demo2026!' }).expect(200)
    await request(app).get(`/api/${centralId}/reports/export.xlsx`).set('Authorization', `Bearer ${login.body.token}`).expect(200)
    await request(app).get(`/api/${serviceId}/inventory`).set('Authorization', `Bearer ${login.body.token}`).expect(200)
  })

  test('site invites cannot grant a higher role and stay tenant-scoped', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'manager@opshub.local', password: 'Demo2026!' }).expect(200)
    const headers = { Authorization: `Bearer ${login.body.token}` }
    await request(app).post(`/api/${centralId}/users`).set(headers).send({ name: 'New Admin', email: 'new-admin@opshub.local', password: 'LongDemoPass1!', role: 'Admin' }).expect(403)
    const invite = await request(app).post(`/api/${centralId}/users`).set(headers).send({ name: 'New Member', email: 'new-member@opshub.local', password: 'LongDemoPass1!', phone: '+919876543211', role: 'Member' }).expect(201)
    assert.equal(invite.body.user.siteId, centralId)
    assert.equal(invite.body.user.phone, '+919876543211')
    await request(app).get(`/api/${centralId}/users`).set(headers).expect(200)
    const memberLogin = await request(app).post('/api/auth/login').send({ email: 'new-member@opshub.local', password: 'LongDemoPass1!' }).expect(200)
    await request(app).get(`/api/${serviceId}/inventory`).set('Authorization', `Bearer ${memberLogin.body.token}`).expect(403)
  })

  test('rejects a request that references inventory from another site', async () => {
    await request(app).post(`/api/${centralId}/requests`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Cross-site probe', itemId: '20000000-0000-4000-8000-000000000006', quantity: 1 }).expect(404)
    assert.equal(state.requests.some((item) => item.title === 'Cross-site probe'), false)
  })

  test('runtime schemas reject malformed inventory, request, and module payloads', async () => {
    const headers = { Authorization: `Bearer ${adminToken}` }
    const requestCount = state.requests.length
    await request(app).post(`/api/${centralId}/requests`).set(headers).send({ title: 'Negative quantity', itemId: '20000000-0000-4000-8000-000000000001', quantity: -2 }).expect(400)
    await request(app).post(`/api/${centralId}/inventory`).set(headers).send({ name: 'Bad quantity', sku: 'BAD-1', quantity: 'many', price: 2 }).expect(400)
    await request(app).post(`/api/${centralId}/components`).set(headers).send({ nodes: [{ id: 'fake-inventory', data: { moduleId: 'inventory', inputs: ['FakeInput'], outputs: ['StockItem'] } }], edges: [], modules: ['inventory'] }).expect(400)
    assert.equal(state.requests.length, requestCount)
    assert.ok(!state.inventory.some((item) => item.sku === 'BAD-1'))
  })

  test('MiniMoth OTP verifies an enrolled phone and then issues an OpsHub session', async () => {
    const state = createMemoryState()
    state.users[0].phone = '+919876543210'
    const calls = []
    const minimoth = { otp: {
      send: async ({ phone }) => { calls.push(['send', phone]); return { otpId: 'otp-demo-id' } },
      verify: async ({ phone, otp }) => { calls.push(['verify', phone, otp]); return { valid: otp === '123456', code: 'INVALID_OTP' } },
    } }
    const otpApp = createApp({ state, database: null, minimoth })
    await request(otpApp).get('/api/auth/methods').expect(200).expect(({ body }) => assert.equal(body.minimothOtp, true))
    const sent = await request(otpApp).post('/api/auth/otp/send').send({ phone: '+919876543210' }).expect(200)
    assert.equal(sent.body.otpId, 'otp-demo-id')
    await request(otpApp).post('/api/auth/otp/send').send({ phone: '+919876543211' }).expect(404)
    await request(otpApp).post('/api/auth/otp/verify').send({ phone: '+919876543210', otp: '000000' }).expect(401)
    const verified = await request(otpApp).post('/api/auth/otp/verify').send({ phone: '+919876543210', otp: '123456' }).expect(200)
    assert.equal(verified.body.user.email, 'admin@opshub.local')
    await request(otpApp).get('/api/session').set('Authorization', `Bearer ${verified.body.token}`).expect(200)
    assert.equal(calls.filter(([action]) => action === 'send').length, 1)
  })

  test('MiniMoth routes fail closed when the server key is not configured', async () => {
    const otpApp = createApp({ state: createMemoryState(), database: null, minimoth: null })
    const methods = await request(otpApp).get('/api/auth/methods').expect(200)
    assert.equal(methods.body.password, true)
    assert.equal(methods.body.minimothOtp, false)
    await request(otpApp).post('/api/auth/otp/send').send({ phone: '+919876543210' }).expect(503)
  })

  test('approval and assignment decrement stock together', async () => {
    const itemBefore = state.inventory.find((item) => item.id === '20000000-0000-4000-8000-000000000001').quantity
    const response = await request(app).post(`/api/${centralId}/approvals`).set('Authorization', `Bearer ${adminToken}`).send({ requestId: '30000000-0000-4000-8000-000000000001', decision: 'approve' }).expect(200)
    assert.equal(response.body.request.status, 'Assigned')
    assert.equal(response.body.assignment.quantity, 12)
    assert.equal(state.inventory.find((item) => item.id === '20000000-0000-4000-8000-000000000001').quantity, itemBefore - 12)
    assert.equal(state.assignments.filter((item) => item.siteId === centralId).length, 2)
    assert.equal(state.approvals.filter((item) => item.siteId === centralId).length, 1)
  })

  test('insufficient stock leaves request, stock, approval, and assignment unchanged', async () => {
    const item = state.inventory.find((entry) => entry.id === '20000000-0000-4000-8000-000000000001')
    item.quantity = 2
    await request(app).post(`/api/${centralId}/approvals`).set('Authorization', `Bearer ${adminToken}`).send({ requestId: '30000000-0000-4000-8000-000000000001', decision: 'approve' }).expect(409)
    assert.equal(item.quantity, 2)
    assert.equal(state.requests.find((entry) => entry.id === '30000000-0000-4000-8000-000000000001').status, 'Pending approval')
    assert.equal(state.approvals.length, 0)
    assert.equal(state.assignments.filter((entry) => entry.siteId === centralId).length, 1)
  })

  test('store replenishment routes to Distribution and approval updates the originating request', async () => {
    const sourceItemId = '20000000-0000-4000-8000-000000000001'
    const distributionItemId = '20000000-0000-4000-8000-000000000009'
    const startingStock = state.inventory.find((item) => item.id === distributionItemId).quantity
    const created = await request(app).post(`/api/${centralId}/requests`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Restock iPhone for Pune', itemId: sourceItemId, quantity: 2, priority: 'Urgent' }).expect(201)
    assert.equal(created.body.request.siteId, distributionId)
    assert.equal(created.body.request.sourceSiteId, centralId)
    const [distributionQueue, storeQueue] = await Promise.all([
      request(app).get(`/api/${distributionId}/requests`).set('Authorization', `Bearer ${adminToken}`).expect(200),
      request(app).get(`/api/${centralId}/requests`).set('Authorization', `Bearer ${adminToken}`).expect(200),
    ])
    assert.ok(distributionQueue.body.requests.some((item) => item.id === created.body.request.id))
    assert.ok(storeQueue.body.requests.some((item) => item.id === created.body.request.id))
    const approved = await request(app).post(`/api/${distributionId}/approvals`).set('Authorization', `Bearer ${adminToken}`).send({ requestId: created.body.request.id, decision: 'approve' }).expect(200)
    assert.equal(approved.body.assignment.siteId, distributionId)
    assert.equal(state.inventory.find((item) => item.id === distributionItemId).quantity, startingStock - 2)
    const updatedStoreQueue = await request(app).get(`/api/${centralId}/requests`).set('Authorization', `Bearer ${adminToken}`).expect(200)
    assert.equal(updatedStoreQueue.body.requests.find((item) => item.id === created.body.request.id).status, 'Assigned')
  })

  test('concurrent approvals cannot issue the same remaining stock twice', async () => {
    const sourceItemId = '20000000-0000-4000-8000-000000000001'
    const distributionItemId = '20000000-0000-4000-8000-000000000009'
    state.inventory.find((item) => item.id === distributionItemId).quantity = 3
    const firstRequest = await request(app).post(`/api/${centralId}/requests`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Parallel store request one', itemId: sourceItemId, quantity: 2 }).expect(201)
    const secondRequest = await request(app).post(`/api/${centralId}/requests`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Parallel store request two', itemId: sourceItemId, quantity: 2 }).expect(201)
    const results = await Promise.all([
      request(app).post(`/api/${distributionId}/approvals`).set('Authorization', `Bearer ${adminToken}`).send({ requestId: firstRequest.body.request.id, decision: 'approve' }),
      request(app).post(`/api/${distributionId}/approvals`).set('Authorization', `Bearer ${adminToken}`).send({ requestId: secondRequest.body.request.id, decision: 'approve' }),
    ])
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
    assert.ok(state.inventory.find((item) => item.id === distributionItemId).quantity >= 0)
    assert.equal(state.assignments.filter((item) => item.siteId === distributionId).length, 1)
  })

  test('consumption and return quantities cannot exceed issued material and good returns restock', async () => {
    const assignmentId = '40000000-0000-4000-8000-000000000001'
    state.assignments.find((entry) => entry.id === assignmentId).status = 'Issued'
    const item = state.inventory.find((entry) => entry.id === '20000000-0000-4000-8000-000000000003')
    const startingQuantity = item.quantity
    await request(app).post(`/api/${centralId}/consumption`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Work order usage', assignmentId, quantity: 1 }).expect(201)
    await request(app).post(`/api/${centralId}/consumption`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Over-issued usage', assignmentId, quantity: 2 }).expect(409)
    const returned = await request(app).post(`/api/${centralId}/returns`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Unused relay returned', assignmentId, quantity: 1, condition: 'Good' }).expect(201)
    assert.equal(returned.body.returns.restocked, true)
    assert.equal(item.quantity, startingQuantity + 1)
    await request(app).post(`/api/${centralId}/returns`).set('Authorization', `Bearer ${adminToken}`).send({ title: 'Duplicate return', assignmentId, quantity: 1, condition: 'Good' }).expect(409)
  })

  test('inventory updates and deletes remain site-scoped and retain referenced history', async () => {
    const headers = { Authorization: `Bearer ${adminToken}` }
    const itemId = '20000000-0000-4000-8000-000000000001'
    const updated = await request(app).patch(`/api/${centralId}/inventory/${itemId}`).set(headers).send({ quantity: 47, price: 38 }).expect(200)
    assert.equal(updated.body.item.quantity, 47)
    assert.equal(updated.body.item.price, 38)
    await request(app).patch(`/api/${centralId}/inventory/20000000-0000-4000-8000-000000000006`).set(headers).send({ quantity: 1 }).expect(404)
    await request(app).delete(`/api/${centralId}/inventory/${itemId}`).set(headers).expect(409)
    const created = await request(app).post(`/api/${centralId}/inventory`).set(headers).send({ name: 'Disposable test stock', sku: 'TEST-DISPOSABLE', quantity: 1, price: 1 }).expect(201)
    await request(app).delete(`/api/${centralId}/inventory/${created.body.item.id}`).set(headers).expect(200)
    assert.ok(!state.inventory.some((item) => item.id === created.body.item.id))
  })

  test('all tenant collections, configuration, releases, and users stay site-scoped', async () => {
    const headers = { Authorization: `Bearer ${adminToken}` }
    const resources = ['inventory', 'requests', 'approvals', 'assignments', 'consumption', 'returns', 'repairs']
    for (const resource of resources) {
      const markerId = `service-marker-${resource}`
      state[resource].push({ id: markerId, siteId: serviceId, title: 'Service-only marker' })
      const central = await request(app).get(`/api/${centralId}/${resource}`).set(headers).expect(200)
      const service = await request(app).get(`/api/${serviceId}/${resource}`).set(headers).expect(200)
      assert.ok(!central.body[resource].some((record) => record.id === markerId), `${resource} leaked into Central Stores`)
      assert.ok(service.body[resource].some((record) => record.id === markerId), `${resource} missing from Service Centre`)
    }

    const centralGraph = graphFor(['inventory'])
    centralGraph.nodes[0].id = 'central-only-node'
    await request(app).post(`/api/${centralId}/components`).set(headers).send(centralGraph).expect(200)
    const [sites, centralConfig, serviceConfig] = await Promise.all([
      request(app).get('/api/sites').set(headers),
      request(app).get(`/api/${centralId}/components`).set(headers),
      request(app).get(`/api/${serviceId}/components`).set(headers),
    ])
    assert.deepEqual(sites.body.sites.find((site) => site.siteId === centralId).modules, ['inventory'])
    assert.equal(centralConfig.body.config.nodes[0].id, 'central-only-node')
    assert.notDeepEqual(centralConfig.body.config, serviceConfig.body.config)

    const [centralReleases, serviceReleases, centralUsers, serviceUsers] = await Promise.all([
      request(app).get(`/api/${centralId}/releases`).set(headers),
      request(app).get(`/api/${serviceId}/releases`).set(headers),
      request(app).get(`/api/${centralId}/users`).set(headers),
      request(app).get(`/api/${serviceId}/users`).set(headers),
    ])
    assert.ok(!centralReleases.body.releases.some((release) => serviceReleases.body.releases.some((other) => other.id === release.id)))
    assert.ok(centralUsers.body.users.some((member) => member.email === 'sam@opshub.local'))
    assert.ok(!serviceUsers.body.users.some((member) => member.email === 'sam@opshub.local'))

    const operationalRecords = [
      { resource: 'consumption', body: { title: 'Central-only consumption', assignmentId: '40000000-0000-4000-8000-000000000001', quantity: 1 } },
      { resource: 'returns', body: { title: 'Central-only returns', assignmentId: '40000000-0000-4000-8000-000000000001', quantity: 1, condition: 'Good' } },
      { resource: 'repairs', body: { title: 'Central-only repairs', serialNumber: 'PCB-CENTRAL-1', fault: 'No power' } },
    ]
    for (const { resource, body } of operationalRecords) {
      await request(app).post(`/api/${centralId}/${resource}`).set(headers).send(body).expect(201)
      const service = await request(app).get(`/api/${serviceId}/${resource}`).set(headers).expect(200)
      assert.ok(!service.body[resource].some((record) => record.title === body.title))
    }
  })

  test('persists only type-compatible workflow edges', async () => {
    const headers = { Authorization: `Bearer ${adminToken}` }
    const approvalGraph = graphFor(['request', 'approval'], [['request', 'approval', 'Request']])
    await request(app).post(`/api/${centralId}/components`).set(headers).send(approvalGraph).expect(200)
    const invalidGraph = graphFor(['request', 'material-assignment'], [['request', 'material-assignment', 'Request']])
    await request(app).post(`/api/${centralId}/components`).set(headers).send(invalidGraph).expect(400)
    await request(app).post(`/api/${centralId}/components`).set(headers).send(graphFor(['approval'])).expect(400)
    assert.deepEqual(state.sites.find((site) => site.siteId === centralId).modules, ['request', 'approval'])
  })

  test('rollback restores a prior site configuration as a new version', async () => {
    const headers = { Authorization: `Bearer ${adminToken}` }
    const initial = state.sites.find((site) => site.siteId === centralId).modules
    await request(app).post(`/api/${centralId}/components`).set(headers).send(graphFor(['request', 'approval'], [['request', 'approval', 'Request']])).expect(200)
    const release = await request(app).post(`/api/${centralId}/releases`).set(headers).send({ status: 'Published' }).expect(201)
    await request(app).post(`/api/${centralId}/components`).set(headers).send(graphFor(['inventory'])).expect(200)
    await request(app).post(`/api/${centralId}/releases`).set(headers).send({ status: 'Published' }).expect(201)
    const restored = await request(app).post(`/api/${centralId}/releases/${state.releases.find((item) => item.siteId === centralId && item.version === 1).id}/rollback`).set(headers).expect(200)
    assert.deepEqual(restored.body.site.modules, initial)
    assert.equal(restored.body.version, 4)
    assert.equal(release.body.release.version, 2)
  })

  test('Excel export is available to site Managers and denied to Members', async () => {
    await request(app).get(`/api/${centralId}/reports/export.xlsx`).set('Authorization', `Bearer ${adminToken}`).expect('Content-Type', /spreadsheetml/).expect(200)
    await request(app).get(`/api/${centralId}/reports/export.xlsx`).set('Authorization', `Bearer ${memberToken}`).expect(403)
  })

  test('Excel import upserts rows into only the selected site', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Inventory')
    sheet.addRow(['SKU', 'Item', 'Category', 'Quantity', 'Reorder At', 'Unit Price', 'Location'])
    sheet.addRow(['CS-IMPORT-1', 'Imported bearing', 'Mechanical', 6, 2, 9.5, 'Dock 1'])
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
    const login = await request(app).post('/api/auth/login').send({ email: 'manager@opshub.local', password: 'Demo2026!' }).expect(200)
    const response = await request(app).post(`/api/${centralId}/reports/import`).set('Authorization', `Bearer ${login.body.token}`).attach('file', buffer, 'stock.xlsx').expect(200)
    assert.equal(response.body.imported, 1)
    assert.ok(state.inventory.some((item) => item.siteId === centralId && item.sku === 'CS-IMPORT-1'))
    assert.ok(!state.inventory.some((item) => item.siteId === serviceId && item.sku === 'CS-IMPORT-1'))
  })
})
