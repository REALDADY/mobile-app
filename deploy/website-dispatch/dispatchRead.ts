import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import pool from '../db/pool'
import { PROMOTION_ACTIVE_SQL } from '../utils/promotions'
import { calculateOrder, normalizeEmirateName } from '../utils/orderCalculator'
import { normalizePhone } from '../utils/phone'
import { insertOrderRecords, sendNewOrderNotifications } from '../services/createOrder'

const router = Router()

function secretsMatch(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer)
}

function isLoopbackRequest(req: Request) {
  const remoteAddress = req.ip || req.socket.remoteAddress || ''
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)
}

router.use((req: Request, res: Response, next) => {
  if (req.method !== 'GET') return next()
  if (isLoopbackRequest(req)) return next()

  const configuredKey = process.env.DISPATCH_READ_KEY || ''
  const providedKey = req.get('x-dispatch-read-key') || ''
  if (!configuredKey) return res.status(503).json({ error: 'Read-only dispatch feed is not configured' })
  if (!providedKey || !secretsMatch(configuredKey, providedKey)) return res.status(401).json({ error: 'Unauthorized' })
  next()
})

function requireDispatchWrite(req: Request, res: Response, next: () => void) {
  const configuredKey = process.env.DISPATCH_WRITE_KEY || ''
  const providedKey = req.get('x-dispatch-write-key') || ''
  if (configuredKey) {
    if (!providedKey || !secretsMatch(configuredKey, providedKey)) return res.status(401).json({ error: 'Unauthorized' })
    return next()
  }
  if (isLoopbackRequest(req)) return next()
  return res.status(503).json({ error: 'Dispatch write access is not configured' })
}

function coordinate(value: unknown, min: number, max: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== 0 ? parsed : null
}

function addressText(snapshot: Record<string, unknown> = {}) {
  return [snapshot.street, snapshot.building, snapshot.floor_unit, snapshot.area, snapshot.emirate]
    .filter(Boolean)
    .join(', ')
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/

// ─── Staff order: validation ──────────────────────────────────
export const DispatchOrderSchema = z.object({
  customer: z.object({
    id:        z.string().regex(UUID_PATTERN, 'Invalid customer id').optional(),
    firstName: z.string().trim().min(1).max(100),
    lastName:  z.string().trim().min(1).max(100),
    phone:     z.string().min(7).max(25).regex(/^[\d+\-\s()]+$/, 'Invalid phone'),
    email:     z.string().trim().email().optional().or(z.literal('')),
  }),
  address: z.object({
    emirate:   z.string().trim().min(1).max(50),
    area:      z.string().trim().min(1).max(255),
    street:    z.string().trim().max(500).optional(),
    building:  z.string().trim().max(255).optional(),
    floorUnit: z.string().trim().max(100).optional(),
    notes:     z.string().trim().max(1000).optional(),
    latitude:  z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  }).refine(
    (a) => (a.latitude === undefined) === (a.longitude === undefined),
    { message: 'latitude and longitude must be provided together', path: ['latitude'] }
  ),
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(100),
    quantity:  z.number().int().min(1).max(1000),
    variant:   z.string().trim().max(100).optional(),
  })).min(1).max(50),
  paymentMethod:  z.enum(['cash_on_delivery', 'card_on_delivery', 'prepaid']),
  notes:          z.string().trim().max(1000).optional(),
  createdBy:      z.string().trim().max(100).optional(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN, 'idempotencyKey must be 8-100 chars of A-Z a-z 0-9 . _ : -'),
})

export type DispatchOrderInput = z.infer<typeof DispatchOrderSchema>
export type DispatchPaymentMethod = DispatchOrderInput['paymentMethod']

/**
 * Dispatch payment → website orders.payment_method / payment_status.
 * 'prepaid' is stored as a non-gateway method already marked paid, so no
 * N-Genius/Tabby flow is ever started for staff orders.
 */
export function mapDispatchPayment(method: DispatchPaymentMethod): { paymentMethod: string, paymentStatus: string } {
  switch (method) {
    case 'cash_on_delivery': return { paymentMethod: 'cash_on_delivery', paymentStatus: 'pending' }
    case 'card_on_delivery': return { paymentMethod: 'card_on_delivery', paymentStatus: 'pending' }
    case 'prepaid':          return { paymentMethod: 'bank_transfer', paymentStatus: 'paid' }
  }
}

export function dispatchPaymentMethodFromOrder(paymentMethod: string): DispatchPaymentMethod {
  if (paymentMethod === 'cash_on_delivery' || paymentMethod === 'card_on_delivery') return paymentMethod
  return 'prepaid'
}

export function buildDispatchAddressSnapshot(address: DispatchOrderInput['address']) {
  return {
    emirate:    normalizeEmirateName(address.emirate),
    area:       address.area,
    street:     address.street || '',
    building_type: '',
    building:   address.building || '',
    floor_unit: address.floorUnit || '',
    notes:      address.notes || '',
    latitude:   address.latitude ?? null,
    longitude:  address.longitude ?? null,
  }
}

type ProductCheckRow = {
  id: string
  slug: string
  name_en: string
  size: string | null
  is_active: boolean
  stock_status: string
  restricted_emirates: string[] | null
  promotion_active: boolean
}

/** 404 for unknown products, 409 for products a customer could not buy right now. */
export function findUnavailableProduct(
  rows: ProductCheckRow[],
  items: { productId: string }[],
  emirate: string
): { status: 404 | 409, error: string } | null {
  const normalizedEmirate = normalizeEmirateName(emirate).toLowerCase()
  for (const item of items) {
    const product = rows.find((p) => p.id === item.productId || p.slug === item.productId)
    if (!product) return { status: 404, error: `Product not found: ${item.productId}` }
    if (!product.is_active || !product.promotion_active) {
      return { status: 409, error: `Product "${product.name_en}" is not currently sold on the website` }
    }
    if (product.stock_status === 'out_of_stock') {
      return { status: 409, error: `Product "${product.name_en}" is out of stock` }
    }
    const restricted = (product.restricted_emirates || [])
      .some((r) => normalizeEmirateName(r).toLowerCase() === normalizedEmirate)
    if (restricted) {
      return { status: 409, error: `Product "${product.name_en}" is not available for delivery to ${emirate}` }
    }
  }
  return null
}

/** Split order_items.product_size ("<size> - <variant>", see calculateOrder) back into size + variant. */
export function splitProductSize(productSize: string | null, baseSize: string | null) {
  const stored = String(productSize || '')
  const base = String(baseSize || '')
  if (!stored) return { size: base || null, variant: null }
  if (base && stored === base) return { size: base, variant: null }
  if (base && stored.startsWith(`${base} - `)) return { size: base, variant: stored.slice(base.length + 3) || null }
  if (!base) return { size: null, variant: stored }
  return { size: stored, variant: null }
}

export function mapDispatchOrder(order: Record<string, any>, items: Record<string, any>[]) {
  const address = (order.address_snapshot || {}) as Record<string, unknown>
  const customer = (order.customer_snapshot || {}) as Record<string, unknown>
  return {
    id: String(order.id),
    orderNumber: String(order.order_number),
    status: String(order.status || 'pending').toUpperCase(),
    createdAt: order.created_at,
    customerId: order.customer_id ? String(order.customer_id) : null,
    customerName: String(customer.full_name || ''),
    phone: String(customer.phone || ''),
    email: customer.email ? String(customer.email) : null,
    address: addressText(address),
    emirate: String(address.emirate || ''),
    area: String(address.area || ''),
    latitude: coordinate(address.latitude, -90, 90),
    longitude: coordinate(address.longitude, -180, 180),
    items: items.map((item) => {
      const { size, variant } = splitProductSize(item.product_size, item.base_size)
      return {
        productId: item.product_id ? String(item.product_id) : null,
        name: String(item.product_name || ''),
        size,
        variant,
        quantity: Number(item.quantity || 0),
        unitPrice: Number(item.unit_price || 0),
        lineTotal: Number(item.total_price || 0),
      }
    }),
    subtotal: Number(order.subtotal || 0),
    deliveryFee: Number(order.delivery_fee || 0),
    vat: Number(order.coupon_vat || 0),
    bottleDeposit: Number(order.bottle_deposit || 0),
    total: Number(order.total || 0),
    paymentMethod: dispatchPaymentMethodFromOrder(String(order.payment_method || '')),
    paymentStatus: String(order.payment_status || '').toUpperCase(),
  }
}

export function mapDispatchProduct(row: Record<string, any>) {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name_en || ''),
    size: row.size ? String(row.size) : null,
    category: row.category_name ? String(row.category_name) : null,
    unitPrice: Number(row.price || 0),
    imageUrl: row.image_url ? String(row.image_url) : null,
    // Variants are free-text cart labels on the website (no price impact, no table).
    variants: [] as { id: string, name: string, unitPrice: number }[],
    active: true as const,
  }
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }

async function loadDispatchOrder(db: Queryable, orderId: string) {
  const orderResult = await db.query(`
    SELECT id, order_number, status, created_at, customer_id,
           customer_snapshot, address_snapshot,
           subtotal, delivery_fee, coupon_vat, bottle_deposit, total,
           payment_method, payment_status
    FROM orders WHERE id = $1
  `, [orderId])
  if (!orderResult.rows[0]) return null
  const itemsResult = await db.query(`
    SELECT oi.product_id, oi.product_name, oi.product_size, oi.quantity,
           oi.unit_price, oi.total_price, p.size AS base_size
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = $1
    ORDER BY oi.product_name, oi.id
  `, [orderId])
  return mapDispatchOrder(orderResult.rows[0], itemsResult.rows)
}

async function findIdempotentOrderId(db: Queryable, idempotencyKey: string): Promise<string | null> {
  const result = await db.query(`
    SELECT entity_id FROM audit_logs
    WHERE action = 'dispatch_order_created' AND metadata->>'idempotencyKey' = $1
    ORDER BY created_at ASC
    LIMIT 1
  `, [idempotencyKey])
  return result.rows[0]?.entity_id ? String(result.rows[0].entity_id) : null
}

router.get('/overview', async (_req: Request, res: Response) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const ordersResult = await client.query(`
        SELECT o.*, c.full_name AS customer_name, c.phone AS customer_phone
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.status IN ('pending', 'confirmed', 'preparing', 'out_for_delivery')
        ORDER BY o.created_at ASC
      `)
    const itemsByOrder = new Map<string, Record<string, unknown>[]>()
    const orderIds = ordersResult.rows.map((order) => order.id)
    if (orderIds.length) {
      const itemsResult = await client.query(`
        SELECT id, order_id, product_id, product_name, product_size,
               quantity, unit_price, line_subtotal,
               deposit_per_unit, deposit_total, total_price,
               to_jsonb(order_items)->>'product_variant_id' AS product_variant_id
        FROM order_items
        WHERE order_id = ANY($1::uuid[])
        ORDER BY order_id, product_name, id
      `, [orderIds])
      for (const item of itemsResult.rows) {
        const orderId = String(item.order_id)
        const items = itemsByOrder.get(orderId) || []
        items.push({
          id: String(item.id),
          productId: item.product_id ? String(item.product_id) : null,
          productName: item.product_name,
          productSize: item.product_size || '',
          productVariantId: item.product_variant_id || null,
          quantity: Number(item.quantity || 0),
          unitPrice: Number(item.unit_price || 0),
          lineSubtotal: Number(item.line_subtotal || 0),
          depositPerUnit: Number(item.deposit_per_unit || 0),
          depositTotal: Number(item.deposit_total || 0),
          totalPrice: Number(item.total_price || 0),
        })
        itemsByOrder.set(orderId, items)
      }
    }
    const customersResult = await client.query(`
        SELECT c.id, c.full_name, c.phone, c.created_at,
               latest.address_snapshot, latest.created_at AS last_order_at
        FROM customers c
        LEFT JOIN LATERAL (
          SELECT o.address_snapshot, o.created_at
          FROM orders o
          WHERE o.customer_id = c.id
            AND NULLIF(o.address_snapshot->>'latitude', '') IS NOT NULL
            AND NULLIF(o.address_snapshot->>'longitude', '') IS NOT NULL
          ORDER BY o.created_at DESC
          LIMIT 1
        ) latest ON TRUE
        ORDER BY c.created_at DESC
      `)
    const totalsResult = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM customers)::int AS customers,
          (SELECT COUNT(*) FROM orders WHERE status IN ('pending', 'confirmed', 'preparing', 'out_for_delivery'))::int AS active_orders
      `)
    await client.query('ROLLBACK')

    const orders = ordersResult.rows.map((order) => {
      const address = (order.address_snapshot || {}) as Record<string, unknown>
      const customer = (order.customer_snapshot || {}) as Record<string, unknown>
      const referral = (order.referral || {}) as Record<string, unknown>
      return {
        id: String(order.id),
        orderNumber: order.order_number,
        total: Number(order.total || 0),
        createdAt: order.created_at,
        status: String(order.status || 'pending').toUpperCase(),
        paymentMethod: order.payment_method || '',
        paymentStatus: String(order.payment_status || '').toUpperCase(),
        referral: {
          source: String(referral.source || ''),
          medium: String(referral.medium || ''),
          campaign: String(referral.campaign || ''),
          referrer: String(referral.referrer || ''),
        },
        deliveryNotes: order.notes || '',
        deliveryDate: order.delivery_date,
        deliverySlot: order.delivery_time_slot || '',
        items: itemsByOrder.get(String(order.id)) || [],
        customerName: order.customer_name || customer.full_name || 'Customer',
        customerPhone: order.customer_phone || customer.phone || '',
        address: addressText(address),
        area: String(address.area || address.emirate || ''),
        latitude: coordinate(address.latitude, -90, 90),
        longitude: coordinate(address.longitude, -180, 180),
        assignedDriverId: null,
        driverName: null,
        driverColor: null,
        zoneName: String(address.area || address.emirate || ''),
        routeSequence: null,
        routeExcluded: true,
      }
    })

    const customers = customersResult.rows.map((customer) => {
      const address = (customer.address_snapshot || {}) as Record<string, unknown>
      return {
        id: String(customer.id),
        name: customer.full_name,
        phone: customer.phone,
        address: addressText(address),
        area: String(address.area || address.emirate || ''),
        latitude: coordinate(address.latitude, -90, 90),
        longitude: coordinate(address.longitude, -180, 180),
        lastOrderAt: customer.last_order_at,
      }
    })

    res.json({
      generatedAt: new Date().toISOString(),
      source: 'website',
      stats: totalsResult.rows[0],
      orders,
      customers,
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.error('[Dispatch read] overview error:', error)
    res.status(500).json({ error: 'Could not load website dispatch data' })
  } finally {
    client.release()
  }
})

// Same active/promotion filter and ordering as public GET /api/products, minus
// out-of-stock items (calculateOrder refuses them, so customers can't buy them).
router.get('/products', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.slug, p.name_en, p.size, p.price, p.image_url,
             c.name_en AS category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.is_active = TRUE
        AND ${PROMOTION_ACTIVE_SQL('p')}
        AND p.stock_status <> 'out_of_stock'
      ORDER BY
        CASE p.stock_status
          WHEN 'in_stock' THEN 0
          WHEN 'limited' THEN 1
          WHEN 'out_of_stock' THEN 2
          ELSE 3
        END ASC,
        c.sort_order ASC,
        p.created_at ASC
    `)
    res.json({ products: result.rows.map(mapDispatchProduct) })
  } catch (error) {
    console.error('[Dispatch read] products error:', error)
    res.status(500).json({ error: 'Could not load website products' })
  }
})

router.get('/customers/:id/orders', async (req: Request, res: Response) => {
  const customerId = String(req.params.id || '').trim()
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuidPattern.test(customerId)) return res.status(400).json({ error: 'Invalid customer id' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const result = await client.query(`
      SELECT o.id, o.order_number, o.total, o.status,
             o.payment_method, o.payment_status, o.created_at,
             o.delivery_date, o.delivery_time_slot, o.notes, o.referral,
             (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM orders o
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC
      LIMIT 100
    `, [customerId])
    const orderIds = result.rows.map((order) => order.id)
    const itemsByOrder = new Map<string, Record<string, unknown>[]>()
    if (orderIds.length) {
      const itemsResult = await client.query(`
        SELECT id, order_id, product_name, product_size, quantity,
               unit_price, line_subtotal, deposit_total, total_price,
               to_jsonb(order_items)->>'product_variant_id' AS product_variant_id
        FROM order_items
        WHERE order_id = ANY($1::uuid[])
        ORDER BY order_id, product_name, id
      `, [orderIds])
      for (const item of itemsResult.rows) {
        const orderId = String(item.order_id)
        const items = itemsByOrder.get(orderId) || []
        items.push({
          id: String(item.id),
          productName: String(item.product_name || 'Product'),
          productSize: String(item.product_size || ''),
          productVariantId: item.product_variant_id || null,
          quantity: Number(item.quantity || 0),
          unitPrice: Number(item.unit_price || 0),
          lineSubtotal: Number(item.line_subtotal || 0),
          depositTotal: Number(item.deposit_total || 0),
          totalPrice: Number(item.total_price || 0),
        })
        itemsByOrder.set(orderId, items)
      }
    }
    await client.query('ROLLBACK')

    return res.json({
      customerId,
      orders: result.rows.map((order) => {
        const referral = (order.referral || {}) as Record<string, unknown>
        return {
          id: String(order.id),
          orderNumber: String(order.order_number || order.id),
          total: Number(order.total || 0),
          status: String(order.status || 'pending').toUpperCase(),
          paymentMethod: String(order.payment_method || ''),
          paymentStatus: String(order.payment_status || '').toUpperCase(),
          createdAt: order.created_at,
          deliveryDate: order.delivery_date,
          deliverySlot: String(order.delivery_time_slot || ''),
          deliveryNotes: String(order.notes || ''),
          referral: {
            source: String(referral.source || ''),
            medium: String(referral.medium || ''),
            campaign: String(referral.campaign || ''),
            referrer: String(referral.referrer || ''),
          },
          itemCount: Number(order.item_count || 0),
          items: itemsByOrder.get(String(order.id)) || [],
        }
      }),
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.error('[Dispatch read] customer order history error:', error)
    return res.status(500).json({ error: 'Could not load customer order history' })
  } finally {
    client.release()
  }
})

router.post('/orders/:id/complete', requireDispatchWrite, async (req: Request, res: Response) => {
  const orderId = String(req.params.id || '').trim()
  const driverId = String(req.body?.driverId || '').trim()
  const completedAt = String(req.body?.completedAt || '').trim()
  const proof = req.body?.proof || {}
  const emptyBottlesReturned = Number(req.body?.emptyBottlesReturned || 0)
  const cashCollected = Number(req.body?.cashCollected || 0)
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const validProof = proof
    && proof.bucket === 'delivery-proofs'
    && typeof proof.path === 'string'
    && proof.path.length >= 8
    && proof.path.length <= 500
    && !proof.path.includes('..')
    && ['image/jpeg', 'image/png', 'image/webp'].includes(String(proof.mimeType || '').toLowerCase())
    && Number.isInteger(Number(proof.size))
    && Number(proof.size) >= 1024
    && Number(proof.size) <= 5 * 1024 * 1024

  if (!uuidPattern.test(orderId) || !uuidPattern.test(driverId)) return res.status(400).json({ error: 'Invalid order or driver id' })
  if (!completedAt || Number.isNaN(Date.parse(completedAt))) return res.status(400).json({ error: 'Invalid completion time' })
  if (!validProof) return res.status(400).json({ error: 'Valid delivery proof metadata is required' })
  if (!Number.isInteger(emptyBottlesReturned) || emptyBottlesReturned < 0 || emptyBottlesReturned > 999) return res.status(400).json({ error: 'Invalid empty bottle count' })
  if (!Number.isFinite(cashCollected) || cashCollected < 0 || cashCollected > 100000) return res.status(400).json({ error: 'Invalid cash amount' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query(
      'SELECT id, order_number, status, total, payment_method, payment_status FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    )
    const current = currentResult.rows[0]
    if (!current) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Order not found' })
    }
    if (current.status === 'delivered') {
      await client.query('ROLLBACK')
      return res.json({ id: current.id, orderNumber: current.order_number, status: 'DELIVERED', alreadyCompleted: true })
    }
    if (!['pending', 'confirmed', 'preparing', 'out_for_delivery'].includes(current.status)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: `Order is already ${current.status}` })
    }
    if (current.payment_method === 'cash_on_delivery' && cashCollected + 0.01 < Number(current.total || 0)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Cash collected must cover the AED ${Number(current.total || 0).toFixed(2)} amount due` })
    }

    const updatedResult = await client.query(
      `UPDATE orders
       SET status = 'delivered',
           payment_status = CASE
             WHEN payment_method = 'cash_on_delivery' AND $2 >= total THEN 'paid'
             ELSE payment_status
           END
       WHERE id = $1
       RETURNING id, order_number, status, payment_status`,
      [orderId, cashCollected]
    )
    await client.query(
      `INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
       VALUES (NULL, 'driver_delivery_completed', 'order', $1, $2, $3, $4)`,
      [orderId, JSON.stringify({
        previousStatus: current.status,
        status: 'delivered',
        driverId,
        proof: {
          bucket: proof.bucket,
          path: proof.path,
          mimeType: proof.mimeType,
          size: Number(proof.size),
        },
        emptyBottlesReturned,
        cashCollected,
        completedAt,
      }), req.ip, req.headers['user-agent'] || null]
    )
    await client.query('COMMIT')
    const updated = updatedResult.rows[0]
    return res.json({
      id: updated.id,
      orderNumber: updated.order_number,
      status: String(updated.status).toUpperCase(),
      paymentStatus: String(updated.payment_status).toUpperCase(),
      completedAt,
      proofStored: true,
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.error('[Dispatch write] delivery completion error:', error)
    return res.status(500).json({ error: 'Could not complete website delivery' })
  } finally {
    client.release()
  }
})

// Staff-created order. Same pricing, numbering, customer upsert and
// notifications as public checkout (POST /api/orders), without customer OTP.
router.post('/orders', requireDispatchWrite, async (req: Request, res: Response) => {
  const parsed = DispatchOrderSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors })
  }
  const data = parsed.data

  let orderPhone: string
  try {
    orderPhone = normalizePhone(data.customer.phone)
  } catch {
    return res.status(400).json({ error: 'A valid phone number is required' })
  }

  try {
    const existingOrderId = await findIdempotentOrderId(pool, data.idempotencyKey)
    if (existingOrderId) {
      const order = await loadDispatchOrder(pool, existingOrderId)
      if (order) return res.status(200).json({ order, replayed: true })
    }
  } catch (error) {
    console.error('[Dispatch write] idempotency lookup error:', error)
    return res.status(500).json({ error: 'Could not create website order' })
  }

  const fullName = `${data.customer.firstName} ${data.customer.lastName}`.trim()
  const email = data.customer.email || undefined
  const addressSnapshot = buildDispatchAddressSnapshot(data.address)
  const orderEmirate = addressSnapshot.emirate
  const { paymentMethod, paymentStatus } = mapDispatchPayment(data.paymentMethod)

  // Existing customer: the order belongs to that account (like an OTP-verified
  // account phone); the given phone is the delivery contact on the order.
  let accountPhone = orderPhone
  let lines: Awaited<ReturnType<typeof calculateOrder>>['lines']
  let subtotal: number, coupon_vat: number, bottle_deposit: number, delivery_fee: number, total: number
  try {
    if (data.customer.id) {
      const customerResult = await pool.query('SELECT id, phone FROM customers WHERE id = $1', [data.customer.id])
      if (!customerResult.rows[0]) return res.status(404).json({ error: 'Customer not found' })
      accountPhone = String(customerResult.rows[0].phone)
    }

    const productIds = data.items.map((item) => item.productId)
    const productResult = await pool.query(`
      SELECT p.id, p.slug, p.name_en, p.size, p.is_active, p.stock_status, p.restricted_emirates,
             (${PROMOTION_ACTIVE_SQL('p')}) AS promotion_active
      FROM products p
      WHERE p.id::text = ANY($1) OR p.slug = ANY($1)
    `, [productIds])
    const unavailable = findUnavailableProduct(productResult.rows, data.items, orderEmirate)
    if (unavailable) return res.status(unavailable.status).json({ error: unavailable.error })
  } catch (error) {
    console.error('[Dispatch write] order pre-check error:', error)
    return res.status(500).json({ error: 'Could not create website order' })
  }

  try {
    ;({ lines, subtotal, coupon_vat, bottle_deposit, delivery_fee, total } = await calculateOrder(
      data.items.map((item) => ({ id: item.productId, quantity: item.quantity, variant: item.variant })),
      orderEmirate
    ))
  } catch (calcErr: unknown) {
    const msg = calcErr instanceof Error ? calcErr.message : 'Order calculation failed'
    return res.status(400).json({ error: msg })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialise concurrent requests carrying the same key, then re-check.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dispatch_order:${data.idempotencyKey}`])
    const raceOrderId = await findIdempotentOrderId(client, data.idempotencyKey)
    if (raceOrderId) {
      await client.query('ROLLBACK')
      const order = await loadDispatchOrder(pool, raceOrderId)
      if (order) return res.status(200).json({ order, replayed: true })
      return res.status(500).json({ error: 'Could not create website order' })
    }

    const { customerId, order } = await insertOrderRecords(client, {
      fullName,
      accountPhone,
      orderPhone,
      email,
      initialStatus: 'pending',
      subtotal, coupon_vat, delivery_fee, bottle_deposit,
      discountAmount: 0,
      total,
      paymentMethod,
      paymentStatus,
      addressSnapshot,
      promoCodeId: null,
      appliedPromoCode: null,
      incrementPromoUsage: false,
      notes: [data.address.notes, data.notes].filter(Boolean).join('\n') || undefined,
      source: 'phone',
      referral: { source: 'dispatch', medium: 'staff' },
      lines,
    })

    await client.query(
      `INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
       VALUES (NULL, 'dispatch_order_created', 'order', $1, $2, $3, $4)`,
      [order.id, JSON.stringify({
        idempotencyKey: data.idempotencyKey,
        createdBy: data.createdBy || null,
        source: 'dispatch',
        orderNumber: order.order_number,
        customerId,
        paymentMethod: data.paymentMethod,
        total,
      }), req.ip, req.headers['user-agent'] || null]
    )
    await client.query('COMMIT')

    sendNewOrderNotifications({
      orderId:            order.id,
      order_number:       order.order_number,
      customer_name:      fullName,
      customer_phone:     orderPhone,
      customer_email:     email,
      total,
      subtotal,
      coupon_vat,
      delivery_fee,
      bottle_deposit,
      emirate:            orderEmirate,
      payment_method:     paymentMethod,
      address_snapshot:   addressSnapshot,
      lines,
    })

    const created = await loadDispatchOrder(pool, order.id).catch((error) => {
      console.error('[Dispatch write] created order reload error:', error)
      return null
    })
    if (!created) {
      // Order is committed; return what we know rather than inviting a retry.
      return res.status(201).json({ order: { id: String(order.id), orderNumber: order.order_number, createdAt: order.created_at, customerId: String(customerId), total } })
    }
    return res.status(201).json({ order: created })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.error('[Dispatch write] create order error:', error)
    return res.status(500).json({ error: 'Could not create website order' })
  } finally {
    client.release()
  }
})

export default router
