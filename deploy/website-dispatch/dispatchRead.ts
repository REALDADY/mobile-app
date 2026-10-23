import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import pool from '../db/pool'

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

export default router
